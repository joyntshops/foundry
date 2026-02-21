/**
 * tmux session management
 */
import { execFileSync } from 'node:child_process';

function tmux(args: string[]): string {
  return execFileSync('tmux', args, {
    encoding: 'utf-8',
    timeout: 10_000,
    env: { ...process.env },
  }).trim();
}

function tmuxSafe(args: string[]): string | null {
  try {
    return tmux(args);
  } catch {
    return null;
  }
}

export function sessionExists(name: string): boolean {
  return tmuxSafe(['has-session', '-t', name]) !== null;
}

export function createSession(name: string, cwd: string): void {
  tmux(['new-session', '-d', '-s', name, '-c', cwd]);
}

export function sendKeys(session: string, keys: string): void {
  tmux(['send-keys', '-t', session, keys, 'Enter']);
}

export function killSession(name: string): void {
  tmuxSafe(['kill-session', '-t', name]);
}

export interface TmuxSessionInfo {
  name: string;
  created: string;
  attached: boolean;
  windows: number;
}

export function listSessions(): TmuxSessionInfo[] {
  const raw = tmuxSafe([
    'list-sessions',
    '-F',
    '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_windows}',
  ]);
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map(line => {
    const [name, created, attached, windows] = line.split('\t');
    return {
      name,
      created: new Date(Number(created) * 1000).toISOString(),
      attached: attached === '1',
      windows: Number(windows),
    };
  });
}

export function listFoundrySessions(prefix: string = 'foundry-'): TmuxSessionInfo[] {
  return listSessions().filter(s => s.name.startsWith(prefix));
}

export function attachSession(name: string): void {
  // This must be run in the foreground — spawns an interactive process
  const { execFileSync } = require('node:child_process');
  execFileSync('tmux', ['attach-session', '-t', name], {
    stdio: 'inherit',
  });
}

export function sendInterrupt(session: string): void {
  tmuxSafe(['send-keys', '-t', session, 'C-c', '']);
}

export function capturePane(session: string, lines: number = 50): string | null {
  return tmuxSafe(['capture-pane', '-t', session, '-p', '-S', `-${lines}`]);
}
