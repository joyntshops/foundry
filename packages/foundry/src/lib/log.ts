/**
 * Simple structured logger
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug' | 'success';

const COLORS: Record<LogLevel, string> = {
  info: '\x1b[36m',    // cyan
  warn: '\x1b[33m',    // yellow
  error: '\x1b[31m',   // red
  debug: '\x1b[90m',   // gray
  success: '\x1b[32m', // green
};
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

let verbose = false;

export function setVerbose(v: boolean): void {
  verbose = v;
}

function fmt(level: LogLevel, msg: string): string {
  const ts = new Date().toISOString().slice(11, 19);
  const color = COLORS[level];
  const tag = level === 'success' ? 'ok' : level;
  return `${BOLD}${color}[${tag}]${RESET} ${color}${ts}${RESET} ${msg}`;
}

export function info(msg: string): void {
  console.log(fmt('info', msg));
}

export function warn(msg: string): void {
  console.warn(fmt('warn', msg));
}

export function error(msg: string): void {
  console.error(fmt('error', msg));
}

export function debug(msg: string): void {
  if (verbose) console.log(fmt('debug', msg));
}

export function success(msg: string): void {
  console.log(fmt('success', msg));
}

export function table(rows: Record<string, string>[]): void {
  if (rows.length === 0) return;
  console.table(rows);
}
