/**
 * foundry setup-bot — create a GitHub App via manifest flow and install it.
 *
 * UX: two browser clicks, zero manual config.
 *   1. Opens browser to GitHub App manifest creation page
 *   2. Receives callback with code, exchanges for credentials
 *   3. Opens browser to install the App on repos
 *   4. Polls for installation, saves credentials
 *   5. Verifies API access
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
 * Build the GitHub App manifest JSON.
 */
export function buildManifest(name: string, redirectUrl: string): AppManifest {
  return {
    name,
    url: 'https://github.com/joyntshops/foundry',
    hook_attributes: { url: 'https://example.com/unused', active: false },
    redirect_url: redirectUrl,
    public: false,
    default_permissions: {
      issues: 'write',
      pull_requests: 'write',
      contents: 'write',
      metadata: 'read',
    },
    default_events: ['issues', 'pull_request', 'pull_request_review'],
  };
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
 * Poll for an installation of the App.
 */
async function pollForInstallation(
  appId: number,
  privateKey: string,
  maxWaitMs = 5 * 60 * 1000,
): Promise<number> {
  const { createAppAuth } = await import('@octokit/auth-app');
  const { Octokit } = await import('@octokit/rest');

  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: String(appId), privateKey },
  });

  const start = Date.now();
  const pollInterval = 3000;

  while (Date.now() - start < maxWaitMs) {
    try {
      const { data: installations } = await (octokit as any).rest.apps.listInstallations({ per_page: 1 });
      if (installations.length > 0) {
        return installations[0].id;
      }
    } catch {
      // App may not be ready yet
    }
    await new Promise(r => setTimeout(r, pollInterval));
  }

  throw new Error('Timed out waiting for App installation (5 minutes).');
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

/**
 * Main setup-bot flow.
 */
export async function runSetupBot(): Promise<void> {
  const config = loadConfigSafe();
  const repo = config?.repo || repoSlugFromRemote();
  if (!repo) {
    log.error('Could not determine repo. Run from a git repo with a GitHub remote, or run `foundry init` first.');
    process.exitCode = 1;
    return;
  }

  const org = repo.split('/')[0];

  log.info(`Setting up Foundry Bot for ${org}...`);
  log.info('');

  // Check if already set up
  const jsonPath = path.join(STATE_DIR, `github-app-${org}.json`);
  const pemPath = path.join(STATE_DIR, `github-app-${org}.pem`);
  if (fs.existsSync(jsonPath) && fs.existsSync(pemPath)) {
    log.warn(`GitHub App credentials already exist for ${org}.`);
    log.warn(`  ${jsonPath}`);
    log.warn(`  ${pemPath}`);
    log.warn('Delete these files and re-run to set up a new App.');
    return;
  }

  // 1. Find a free port and start the callback server
  const port = await findFreePort();
  const redirectUrl = `http://localhost:${port}/callback`;

  // 2. Build manifest
  const appName = `Foundry Bot ${org}`;
  const manifest = buildManifest(appName, redirectUrl);

  // 3. Build the form-post URL
  //    GitHub requires the manifest to be submitted as a form POST from the browser.
  //    We serve an auto-submitting form that redirects the user to GitHub.
  //    The manifest JSON is injected via JS to avoid HTML attribute escaping issues.
  //    Double-serialize: JS parses the outer string → assigns the inner JSON string to the input.
  const manifestJsonForJs = JSON.stringify(JSON.stringify(manifest));
  const formServer = http.createServer((_req, res) => {
    const settingsBase = `https://github.com/organizations/${org}/settings/apps/new`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html>
<body>
  <form id="f" method="post" action="${settingsBase}">
    <input type="hidden" id="manifest" name="manifest">
  </form>
  <script>
    document.getElementById('manifest').value = ${manifestJsonForJs};
    document.getElementById('f').submit();
  </script>
</body>
</html>`);
  });

  const formPort = await findFreePort();
  await new Promise<void>((resolve) => {
    formServer.listen(formPort, '127.0.0.1', resolve);
  });

  // 4. Start waiting for callback (before opening browser)
  const codePromise = waitForCallback(port);

  // 5. Open browser
  log.info('Opening GitHub to create the app...');
  openBrowser(`http://localhost:${formPort}`);
  log.info('');
  log.info('Waiting for GitHub redirect... (press Ctrl+C to cancel)');

  // 6. Wait for the code
  let code: string;
  try {
    code = await codePromise;
  } finally {
    formServer.close();
  }

  // 7. Exchange code for credentials
  log.info('');
  const appData = await exchangeCode(code);

  // 8. Save credentials
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(pemPath, appData.pem, { mode: 0o600 });
  log.success(`Private key saved to ${pemPath}`);

  const metaJson = { appId: appData.id, slug: appData.slug };
  fs.writeFileSync(jsonPath, JSON.stringify(metaJson, null, 2) + '\n');
  log.success(`App created: ${appData.slug} (ID: ${appData.id})`);

  // 9. Open installation page
  log.info('');
  log.info('Now install the app on your repos:');
  const installUrl = `https://github.com/apps/${appData.slug}/installations/new`;
  openBrowser(installUrl);
  log.info('');
  log.info('Waiting for installation confirmation...');

  // 10. Poll for installation
  const installationId = await pollForInstallation(appData.id, appData.pem);
  log.success(`Installation confirmed (ID: ${installationId})`);

  // 11. Save installationId
  const fullMeta = { ...metaJson, installationId };
  fs.writeFileSync(jsonPath, JSON.stringify(fullMeta, null, 2) + '\n');

  // 12. Verify API access
  const ok = await verifyAppAuth(String(appData.id), appData.pem, String(installationId));
  if (ok) {
    log.success('Test API call successful — actions will appear as "Foundry Bot[bot]"');
  } else {
    log.warn('Test API call failed — the App may need additional permissions.');
  }

  // 13. Print summary
  log.info('');
  log.success(`Setup complete! No other auth needed — Foundry will use the bot for all ${org} repos.`);
  log.info('To use in CI, set these env vars:');
  log.info(`  FOUNDRY_GITHUB_APP_ID=${appData.id}`);
  log.info(`  FOUNDRY_GITHUB_APP_PRIVATE_KEY_PATH=/path/to/key.pem`);
  log.info(`  FOUNDRY_GITHUB_APP_INSTALLATION_ID=${installationId}`);
}
