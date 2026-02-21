/**
 * foundry sessions — list Foundry tmux sessions.
 * foundry attach  — attach to a session.
 * foundry stop    — stop a session safely.
 */
import { loadConfigSafe } from '../config.js';
import * as state from '../lib/state.js';
import * as tmux from '../lib/tmux.js';
import * as github from '../lib/github.js';
import * as log from '../lib/log.js';

export async function runSessions(): Promise<void> {
  const config = loadConfigSafe();
  const sessions = tmux.listFoundrySessions();

  if (sessions.length === 0) {
    log.info('No active Foundry tmux sessions.');
    return;
  }

  log.info(`Foundry tmux sessions: ${sessions.length}`);
  log.info('');

  const tasks = config ? state.getAllTasks(config.repo) : [];

  for (const sess of sessions) {
    const task = tasks.find(t => t.tmux_session === sess.name);
    console.log(`  ${sess.name}`);
    if (task) {
      console.log(`    Issue:    #${task.issue} — ${task.title}`);
      console.log(`    Branch:   ${task.branch}`);
      console.log(`    Worktree: ${task.worktree}`);
      console.log(`    Backend:  ${task.agent_backend}`);
      console.log(`    Status:   ${task.status}`);
    }
    console.log(`    Created:  ${sess.created}`);
    console.log(`    Attached: ${sess.attached ? 'yes' : 'no'}`);
    console.log('');
  }
}

export async function runAttach(target: string): Promise<void> {
  const config = loadConfigSafe();
  let sessionName: string;

  // target can be an issue number or a tmux session name
  const issueNum = parseInt(target, 10);
  if (!isNaN(issueNum) && config) {
    const tasks = state.getAllTasks(config.repo);
    const task = tasks.find(t => t.issue === issueNum);
    if (!task) {
      log.error(`No task found for issue #${issueNum}`);
      return;
    }
    sessionName = task.tmux_session;
  } else {
    sessionName = target;
  }

  if (!tmux.sessionExists(sessionName)) {
    log.error(`tmux session "${sessionName}" does not exist.`);
    return;
  }

  log.info(`Attaching to ${sessionName}...`);
  tmux.attachSession(sessionName);
}

export async function runStop(target: string): Promise<void> {
  const config = loadConfigSafe();
  let sessionName: string;
  let issueNum: number | null = null;

  const parsed = parseInt(target, 10);
  if (!isNaN(parsed) && config) {
    issueNum = parsed;
    const tasks = state.getAllTasks(config.repo);
    const task = tasks.find(t => t.issue === parsed);
    if (!task) {
      log.error(`No task found for issue #${parsed}`);
      return;
    }
    sessionName = task.tmux_session;
  } else {
    sessionName = target;
  }

  if (tmux.sessionExists(sessionName)) {
    log.info(`Sending interrupt to ${sessionName}...`);
    tmux.sendInterrupt(sessionName);
    // Give agent a moment to clean up
    await new Promise(r => setTimeout(r, 2000));
    log.info(`Killing session ${sessionName}...`);
    tmux.killSession(sessionName);
    log.success(`Session ${sessionName} stopped.`);
  } else {
    log.warn(`tmux session "${sessionName}" not found.`);
  }

  if (issueNum && config) {
    state.updateTaskStatus(config.repo, issueNum, 'stopped');
    log.info(`Task #${issueNum} marked as stopped.`);
  }
}
