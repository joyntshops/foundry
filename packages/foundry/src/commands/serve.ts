/**
 * foundry serve — webhook server with reconciliation polling.
 *
 * Starts an HTTP server that receives GitHub webhooks, verifies signatures,
 * converts payloads to FoundryEvents, and dispatches them through the
 * EventHandler. A reconciliation poll runs on a longer interval as a
 * fallback for any missed webhooks.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig, getConfigDir } from '../config.js';
import { EventHandler } from '../lib/event-handler.js';
import { Poller } from '../lib/poller.js';
import { verifyWebhookSignature, webhookToEvents } from '../lib/webhook.js';
import * as state from '../lib/state.js';
import * as log from '../lib/log.js';

const STATE_DIR = path.join(os.homedir(), '.joynt-foundry');
const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface ServeOptions {
  port?: string;
  host?: string;
}

/**
 * Load the webhook secret from ~/.joynt-foundry/github-app-{org}.json
 */
function loadWebhookSecret(repo: string): string | null {
  const org = repo.split('/')[0];
  const jsonPath = path.join(STATE_DIR, `github-app-${org}.json`);
  try {
    const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    return meta.webhookSecret ?? null;
  } catch {
    return null;
  }
}

/**
 * Read the full request body as a string.
 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Send a JSON response.
 */
function jsonResponse(res: http.ServerResponse, statusCode: number, body: Record<string, any>): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function runServe(opts: ServeOptions): Promise<void> {
  const config = loadConfig();
  const repoDir = getConfigDir();
  const port = parseInt(opts.port ?? '3000', 10);
  const host = opts.host ?? '0.0.0.0';

  const webhookSecret = loadWebhookSecret(config.repo);
  if (!webhookSecret) {
    log.warn('No webhook secret found. Run `foundry setup-bot` first, or webhooks will be unverified.');
    log.warn('Continuing without signature verification...');
  }

  let running = true;

  // Graceful shutdown
  process.on('SIGINT', () => {
    log.warn('Shutting down (SIGINT)...');
    running = false;
    server.close();
  });
  process.on('SIGTERM', () => {
    log.warn('Shutting down (SIGTERM)...');
    running = false;
    server.close();
  });

  // Compose EventHandler + Poller for reconciliation
  const handler = new EventHandler(config, repoDir);
  const poller = new Poller(config, repoDir, handler, () => running);

  // ── HTTP Server ─────────────────────────────────────────────────────

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);

    // POST /webhook — GitHub webhook receiver
    if (req.method === 'POST' && url.pathname === '/webhook') {
      await handleWebhook(req, res, config, handler, webhookSecret);
      return;
    }

    // GET /health — health check
    if (req.method === 'GET' && url.pathname === '/health') {
      jsonResponse(res, 200, { status: 'ok' });
      return;
    }

    // GET /status — active task status
    if (req.method === 'GET' && url.pathname === '/status') {
      const tasks = state.getAllTasks(config.repo);
      const activeTasks = tasks.filter(t => !['done', 'failed', 'stopped'].includes(t.status));
      jsonResponse(res, 200, {
        repo: config.repo,
        active_tasks: activeTasks.length,
        tasks: activeTasks.map(t => ({
          issue: t.issue,
          title: t.title,
          status: t.status,
          branch: t.branch,
          pr_url: t.pr_url ?? null,
          updated_at: t.updated_at,
        })),
      });
      return;
    }

    // 404 for everything else
    jsonResponse(res, 404, { error: 'Not found' });
  });

  server.listen(port, host, () => {
    log.success(`Foundry server listening on ${host}:${port}`);
    log.info(`  POST /webhook  — GitHub webhook receiver`);
    log.info(`  GET  /health   — health check`);
    log.info(`  GET  /status   — active task status`);
    log.info('');
    log.info(`Reconciliation poll every ${RECONCILIATION_INTERVAL_MS / 1000}s`);
    log.info('');
  });

  // ── Reconciliation loop ───────────────────────────────────────────────

  while (running) {
    await sleep(RECONCILIATION_INTERVAL_MS);
    if (!running) break;

    log.debug('Running reconciliation poll...');
    try {
      await poller.poll();
    } catch (err: any) {
      log.error(`Reconciliation poll error: ${err.message}`);
    }
  }

  log.info('Server stopped.');
}

// ── Webhook handler ───────────────────────────────────────────────────────

async function handleWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: import('../types.js').FoundryConfig,
  handler: EventHandler,
  webhookSecret: string | null,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch (err: any) {
    log.error(`Failed to read webhook body: ${err.message}`);
    jsonResponse(res, 400, { error: 'Bad request' });
    return;
  }

  // Verify signature if we have a secret
  if (webhookSecret) {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    if (!signature) {
      log.warn('Webhook received without X-Hub-Signature-256 header');
      jsonResponse(res, 401, { error: 'Missing signature' });
      return;
    }
    if (!verifyWebhookSignature(body, signature, webhookSecret)) {
      log.warn('Webhook signature verification failed');
      jsonResponse(res, 401, { error: 'Invalid signature' });
      return;
    }
  }

  // Parse payload
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(body);
  } catch {
    log.warn('Webhook payload is not valid JSON');
    jsonResponse(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const eventName = req.headers['x-github-event'] as string | undefined;
  if (!eventName) {
    jsonResponse(res, 400, { error: 'Missing X-GitHub-Event header' });
    return;
  }

  const deliveryId = req.headers['x-github-delivery'] as string | undefined;
  log.info(`Webhook: ${eventName}.${payload.action ?? ''} [${deliveryId ?? 'no-id'}]`);

  // Respond immediately, then process async
  jsonResponse(res, 200, { received: true });

  // Convert webhook to events and dispatch
  try {
    const events = webhookToEvents(eventName, payload, config);
    for (const event of events) {
      log.info(`Dispatching event: ${event.type}`);
      await handler.handleEvent(event);
    }
  } catch (err: any) {
    log.error(`Error processing webhook: ${err.message}`);
  }
}

// ── Utility ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
