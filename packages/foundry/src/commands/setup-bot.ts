/**
 * foundry setup-bot — create a GitHub App via manifest flow and install it.
 *
 * UX: two browser clicks, zero manual config.
 *   1. Opens browser to GitHub App manifest creation page
 *   2. Receives callback with code, exchanges for credentials
 *   3. Opens browser to install the App on repos
 *   4. Polls for installation, saves credentials
 *   5. Verifies API access
 *
 * `--public` creates the one public Foundry App instead (the joyntshops
 * owner runs this once): same manifest flow with `public: true`, no
 * installation step, and it prints the owner steps GitHub has no API for
 * (logo upload, confirming it is public) plus the broker commands that take
 * the App ID and the private key. See docs/foundry/decisions/.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
import * as log from '../lib/log.js';
import { loadConfigSafe } from '../config.js';

const STATE_DIR = path.join(os.homedir(), '.joynt-foundry');

interface AppManifest {
  name: string;
  url: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
}

/**
 * Every permission Foundry's jobs use. `workflows` is what lets a push add or
 * edit a file under .github/workflows (issue 30); `actions` dispatches
 * previews; `deployments` writes deployment records; `checks` posts the
 * verification check run. docs/foundry/github-backends.md has the table.
 */
export const REQUIRED_PERMISSIONS: Record<string, 'read' | 'write'> = {
  issues: 'write',
  pull_requests: 'write',
  contents: 'write',
  checks: 'write',
  actions: 'write',
  deployments: 'write',
  workflows: 'write',
  metadata: 'read',
};

export interface ManifestOptions {
  /** A public App can be installed by anyone from its App page. */
  public?: boolean;
}

/**
 * Build the GitHub App manifest JSON.
 */
export function buildManifest(name: string, redirectUrl: string, serverUrl?: string, opts: ManifestOptions = {}): AppManifest {
  return {
    name,
    url: 'https://github.com/joyntshops/foundry',
    hook_attributes: {
      url: serverUrl ?? 'https://example.com/unused',
      active: false,
    },
    redirect_url: redirectUrl,
    public: opts.public ?? false,
    default_permissions: { ...REQUIRED_PERMISSIONS },
    default_events: ['issues', 'pull_request', 'pull_request_review', 'issue_comment'],
  };
}

/**
 * Which required permissions an App lacks, given what GitHub reports it has.
 * `write` satisfies a `read` requirement; anything else does not.
 */
export function missingPermissions(granted: Record<string, string> | undefined): string[] {
  const have = granted ?? {};
  return Object.entries(REQUIRED_PERMISSIONS)
    .filter(([key, need]) => {
      const got = have[key];
      if (!got) return true;
      if (need === 'read') return got !== 'read' && got !== 'write';
      return got !== 'write';
    })
    .map(([key, need]) => `${key}: ${need}`);
}

/** The App's settings page on GitHub, which differs for organizations and users. */
export function appSettingsUrl(org: string, isOrg: boolean, slug: string): string {
  return isOrg
    ? `https://github.com/organizations/${org}/settings/apps/${slug}`
    : `https://github.com/settings/apps/${slug}`;
}

/**
 * What the owner of the public App does after `setup-bot --public`, in order.
 * GitHub has no API for the logo or for the public toggle, so these are URLs
 * and the commands that take the App ID and key to the broker.
 */
export function publicAppNextSteps(p: { org: string; isOrg: boolean; slug: string; appId: number; pemPath: string }): string[] {
  const settings = appSettingsUrl(p.org, p.isOrg, p.slug);
  return [
    `App created: ${p.slug} (ID: ${p.appId}). Private key saved to ${p.pemPath} (mode 0600).`,
    '',
    'Owner steps GitHub has no API for:',
    `  1. Logo: ${settings} → Display information → upload packages/foundry/assets/foundry-bot.png`,
    `  2. Confirm it is public: ${settings}/advanced → "Make public" is already done when the button reads "Make private"`,
    `  3. Permissions: ${settings}/permissions should show every row of REQUIRED_PERMISSIONS as granted (checked above)`,
    '',
    'Broker (packages/broker/README.md), with the Foundry AWS account active:',
    `  aws secretsmanager create-secret --name foundry-broker/github-app-private-key --secret-string "file://${p.pemPath}"`,
    `  FOUNDRY_APP_ID=${p.appId} PRIVATE_KEY_SECRET_ARN=<arn from the line above> ARTIFACT_BUCKET=<bucket> ./scripts/deploy.sh`,
    `  rm ${p.pemPath}`,
    '',
    'Then put the broker URL into the broker-url defaults of action.yml and broker-token/action.yml,',
    `and the install link into the docs: https://github.com/apps/${p.slug}/installations/new`,
  ];
}

/**
 * Open a URL in the user's browser.
 */
function openBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') {
      execFileSync('open', [url]);
    } else if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'start', url]);
    } else {
      execFileSync('xdg-open', [url]);
    }
  } catch {
    log.warn(`Could not open browser automatically. Open this URL manually:\n  ${url}`);
  }
}

/**
 * Start a temporary HTTP server and wait for a callback with a `code` query param.
 * Returns the code from the GitHub redirect.
 */
function waitForCallback(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Success! You can close this tab and return to the terminal.</h2></body></html>');
          server.close();
          resolve(code);
        } else {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing code parameter');
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(port, '127.0.0.1');
    server.on('error', reject);

    // Timeout after 5 minutes
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for GitHub callback (5 minutes).'));
    }, 5 * 60 * 1000);

    server.on('close', () => clearTimeout(timeout));
  });
}

/**
 * Find a free port for the callback server.
 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Could not determine port')));
      }
    });
    srv.on('error', reject);
  });
}

/**
 * Exchange the manifest code for App credentials.
 */
async function exchangeCode(code: string): Promise<{
  id: number;
  slug: string;
  pem: string;
  webhook_secret: string;
  client_id: string;
  client_secret: string;
}> {
  const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'joynt-foundry',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub App manifest exchange failed (${res.status}): ${body}`);
  }

  return res.json() as any;
}

/**
 * Check if the App already has an installation (e.g., user installed it manually).
 * Returns the installation ID, or null if none found.
 */
async function findExistingInstallation(appId: number, privateKey: string): Promise<number | null> {
  const { createAppAuth } = await import('@octokit/auth-app');
  const { Octokit } = await import('@octokit/rest');

  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: String(appId), privateKey },
  });

  try {
    const { data: installations } = await (octokit as any).rest.apps.listInstallations({ per_page: 1 });
    if (installations.length > 0) {
      return installations[0].id;
    }
  } catch {
    // Auth may not be working
  }
  return null;
}

/**
 * Poll for an installation of the App.
 * Returns the installation ID, or null if timed out.
 */
async function pollForInstallation(
  appId: number,
  privateKey: string,
  maxWaitMs = 5 * 60 * 1000,
): Promise<number | null> {
  const start = Date.now();
  const pollInterval = 3000;

  while (Date.now() - start < maxWaitMs) {
    const id = await findExistingInstallation(appId, privateKey);
    if (id !== null) return id;
    await new Promise(r => setTimeout(r, pollInterval));
  }

  return null;
}

/**
 * What GitHub says the App is: slug and granted permissions, read with an App JWT.
 */
async function fetchApp(appId: number, privateKey: string): Promise<{ slug: string; permissions: Record<string, string> } | null> {
  const { createAppAuth } = await import('@octokit/auth-app');
  const { Octokit } = await import('@octokit/rest');
  const octokit = new Octokit({ authStrategy: createAppAuth, auth: { appId: String(appId), privateKey } });
  try {
    const { data } = await (octokit as any).rest.apps.getAuthenticated();
    return { slug: data.slug, permissions: data.permissions ?? {} };
  } catch {
    return null;
  }
}

/** Print the permission check; returns true when nothing is missing. */
async function reportPermissions(appId: number, privateKey: string, settingsUrl: string): Promise<boolean> {
  const app = await fetchApp(appId, privateKey);
  if (!app) {
    log.warn('Could not read the App back from GitHub to check its permissions.');
    return false;
  }
  const missing = missingPermissions(app.permissions);
  if (missing.length === 0) {
    log.success('Permissions: every one Foundry needs is granted.');
    return true;
  }
  log.warn(`Permissions missing on the App: ${missing.join(', ')}`);
  log.info(`  Add them at ${settingsUrl}/permissions, then accept the update on each installation`);
  log.info('  (Installed GitHub Apps → Configure); jobs keep the old set until an owner accepts.');
  return false;
}

/**
 * Verify the App can make API calls by listing repos for the installation.
 */
async function verifyAppAuth(appId: string, privateKey: string, installationId: string): Promise<boolean> {
  const { createAppAuth } = await import('@octokit/auth-app');
  const { Octokit } = await import('@octokit/rest');

  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey, installationId },
  });

  try {
    await (octokit as any).rest.apps.listReposAccessibleToInstallation({ per_page: 1 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect repo slug (owner/repo) from git remote origin URL.
 * Works without any GitHub auth — just reads the local git config.
 * Supports SSH (git@github.com:owner/repo.git) and HTTPS (https://github.com/owner/repo.git).
 */
export function repoSlugFromRemote(): string | null {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();

    // SSH: git@github.com:owner/repo.git
    const sshMatch = url.match(/github\.com[:/](.+?\/.+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];

    // HTTPS: https://github.com/owner/repo.git
    const httpsMatch = url.match(/github\.com\/(.+?\/.+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];

    return null;
  } catch {
    return null;
  }
}

interface SetupBotOptions {
  serverUrl?: string;
  /** Create the one public Foundry App (owner use). */
  public?: boolean;
  /** App name; GitHub requires it to be globally unique. */
  name?: string;
  /** Owner of the App; defaults to the repo's owner. */
  org?: string;
}

/** Is `owner` an organization (vs a user)? Falls back to true when GitHub cannot be asked. */
async function isOrganization(owner: string): Promise<boolean> {
  try {
    const ghType = execFileSync('gh', ['api', `/users/${owner}`, '--jq', '.type'], {
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
    return ghType === 'Organization';
  } catch {
    try {
      const resp = await fetch(`https://api.github.com/users/${owner}`, {
        headers: { 'User-Agent': 'joynt-foundry' },
      });
      if (resp.ok) {
        const data = await resp.json() as { type: string };
        return data.type === 'Organization';
      }
    } catch {
      /* fall through */
    }
    return true;
  }
}

/**
 * Serve the manifest form, open the browser, and exchange the callback code.
 */
async function createAppViaManifest(org: string, isOrg: boolean, manifestFor: (redirectUrl: string) => AppManifest): Promise<Awaited<ReturnType<typeof exchangeCode>>> {
  const port = await findFreePort();
  const redirectUrl = `http://localhost:${port}/callback`;
  const manifest = manifestFor(redirectUrl);

  const manifestJsonForJs = JSON.stringify(JSON.stringify(manifest));
  const settingsBase = isOrg
    ? `https://github.com/organizations/${org}/settings/apps/new`
    : 'https://github.com/settings/apps/new';

  const formServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html>
<head><title>Foundry Bot Setup</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 500px; margin: 80px auto; text-align: center;">
  <h2>Create ${manifest.public ? 'the public Foundry App' : 'Foundry Bot'}</h2>
  <p>Click below to create a GitHub App for <strong>${org}</strong>.</p>
  <form id="f" method="post" action="${settingsBase}">
    <input type="hidden" id="manifest" name="manifest">
    <button type="submit" style="font-size: 16px; padding: 12px 24px; cursor: pointer; background: #2ea44f; color: white; border: none; border-radius: 6px;">
      Create GitHub App
    </button>
  </form>
  <script>
    document.getElementById('manifest').value = ${manifestJsonForJs};
  </script>
</body>
</html>`);
  });

  const formPort = await findFreePort();
  await new Promise<void>((resolve) => {
    formServer.listen(formPort, '127.0.0.1', resolve);
  });

  const codePromise = waitForCallback(port);

  const formUrl = `http://localhost:${formPort}`;
  log.info('Opening browser — click "Create GitHub App" to continue...');
  log.info(`  ${formUrl}`);
  openBrowser(formUrl);
  log.info('');
  log.info('Waiting for GitHub redirect... (press Ctrl+C to cancel)');

  let code: string;
  try {
    code = await codePromise;
  } finally {
    formServer.close();
  }

  log.info('');
  return exchangeCode(code);
}

/**
 * `setup-bot --public`: create the public Foundry App for `org` and print the
 * owner steps. No installation step; repositories install it from its page.
 */
async function runSetupPublicApp(org: string, name: string): Promise<void> {
  const jsonPath = path.join(STATE_DIR, `public-app-${org}.json`);
  const pemPath = path.join(STATE_DIR, `public-app-${org}.pem`);
  const isOrg = await isOrganization(org);

  let appId: number;
  let slug: string;
  let privateKey: string;

  if (fs.existsSync(jsonPath) && fs.existsSync(pemPath)) {
    const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    appId = meta.appId;
    slug = meta.slug;
    privateKey = fs.readFileSync(pemPath, 'utf-8');
    log.info(`Public App already created for ${org}: ${slug} (ID: ${appId}). Re-checking and printing the steps again.`);
  } else {
    log.info(`Creating the public Foundry App "${name}" owned by ${org}...`);
    log.info('');
    const appData = await createAppViaManifest(org, isOrg, (redirectUrl) => buildManifest(name, redirectUrl, undefined, { public: true }));
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(pemPath, appData.pem, { mode: 0o600 });
    appId = appData.id;
    slug = appData.slug;
    privateKey = appData.pem;
    fs.writeFileSync(jsonPath, JSON.stringify({ appId, slug, public: true }, null, 2) + '\n');
    log.success(`App created: ${slug} (ID: ${appId})`);
  }

  await reportPermissions(appId, privateKey, appSettingsUrl(org, isOrg, slug));
  log.info('');
  for (const line of publicAppNextSteps({ org, isOrg, slug, appId, pemPath })) log.info(line);
}

/**
 * Main setup-bot flow.
 */
export async function runSetupBot(opts: SetupBotOptions = {}): Promise<void> {
  const config = loadConfigSafe();
  const repo = config?.repo || repoSlugFromRemote();
  const org = opts.org ?? repo?.split('/')[0];
  if (!org) {
    log.error('Could not determine the owner. Run from a git repo with a GitHub remote, pass --org, or run `foundry init` first.');
    process.exitCode = 1;
    return;
  }

  if (opts.public) {
    await runSetupPublicApp(org, opts.name ?? 'Joynt Foundry');
    return;
  }

  const jsonPath = path.join(STATE_DIR, `github-app-${org}.json`);
  const pemPath = path.join(STATE_DIR, `github-app-${org}.pem`);

  // ── Resume logic: detect partial state and pick up where we left off ──

  let appId: number | undefined;
  let slug: string | undefined;
  let privateKey: string | undefined;
  let installationId: number | undefined;
  let webhookSecret: string | undefined;

  if (fs.existsSync(jsonPath) && fs.existsSync(pemPath)) {
    const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    appId = meta.appId;
    slug = meta.slug;
    webhookSecret = meta.webhookSecret;
    privateKey = fs.readFileSync(pemPath, 'utf-8');

    if (meta.installationId) {
      // Fully configured — verify and exit
      log.info(`GitHub App already configured for ${org} (${slug}, ID: ${appId}).`);
      const ok = await verifyAppAuth(String(appId), privateKey, String(meta.installationId));
      if (ok) {
        log.success('Verified — API access is working.');
      } else {
        log.warn('App credentials exist but API verification failed. Check the App installation on GitHub.');
      }
      return;
    }

    // App created but installationId missing — check if installed out-of-band
    log.info(`App "${slug}" (ID: ${appId}) exists but installation is not recorded. Checking...`);
    const existingId = await findExistingInstallation(appId!, privateKey!);
    if (existingId !== null) {
      installationId = existingId;
      log.success(`Found existing installation (ID: ${installationId})`);
    } else {
      log.info('No installation found. Continuing with installation step...');
    }
  }

  // ── Step 1: Create the App (skip if already created) ──

  if (!appId || !privateKey) {
    log.info(`Setting up Foundry Bot for ${org}...`);
    log.info('');

    const isOrg = await isOrganization(org);
    const appName = opts.name ?? `Foundry Bot ${org}`;
    const appData = await createAppViaManifest(org, isOrg, (redirectUrl) => buildManifest(appName, redirectUrl, opts.serverUrl));

    // Save credentials (without installationId for now)
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(pemPath, appData.pem, { mode: 0o600 });
    log.success(`Private key saved to ${pemPath}`);

    appId = appData.id;
    slug = appData.slug;
    privateKey = appData.pem;
    webhookSecret = appData.webhook_secret;

    const metaJson = { appId, slug, webhookSecret };
    fs.writeFileSync(jsonPath, JSON.stringify(metaJson, null, 2) + '\n');
    log.success(`App created: ${slug} (ID: ${appId})`);
  }

  // ── Step 2: Install the App (skip if already installed) ──

  if (!installationId) {
    const installUrl = `https://github.com/apps/${slug}/installations/new`;
    log.info('');
    log.info('Now install the app on your repos:');
    log.info(`  ${installUrl}`);
    openBrowser(installUrl);
    log.info('');
    log.info('Waiting for installation... (press Ctrl+C to cancel)');

    installationId = await pollForInstallation(appId!, privateKey!, 5 * 60 * 1000) ?? undefined;

    if (!installationId) {
      log.warn('Timed out waiting for installation.');
      log.info('If you already installed the app, re-run `foundry setup-bot` to detect it.');
      log.info(`Or install it now at: ${installUrl}`);
      process.exitCode = 1;
      return;
    }

    log.success(`Installation confirmed (ID: ${installationId})`);
  }

  // ── Step 3: Save final state and verify ──

  const fullMeta = { appId, slug, installationId, webhookSecret };
  fs.writeFileSync(jsonPath, JSON.stringify(fullMeta, null, 2) + '\n');

  const ok = await verifyAppAuth(String(appId), privateKey!, String(installationId));
  if (ok) {
    log.success('Test API call successful — actions will appear as "Foundry Bot[bot]"');
  } else {
    log.warn('Test API call failed — the App may need additional permissions.');
  }

  log.info('');
  log.success(`Setup complete. CLI commands on this machine use the saved credentials for ${org} repos automatically.`);
  log.info('');
  log.info('For the GitHub Action, add two repository secrets (the workflow template reads these names):');
  log.info(`  gh secret set FOUNDRY_APP_ID --repo ${org}/<repo> --body ${appId}`);
  log.info(`  gh secret set FOUNDRY_APP_PRIVATE_KEY --repo ${org}/<repo> < ${pemPath}`);
  log.info('');
  await reportPermissions(appId!, privateKey!, appSettingsUrl(org, await isOrganization(org), slug!));
}
