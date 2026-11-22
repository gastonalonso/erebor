/** Vault filesystem work: git, the run lock, log retention. */

import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

import { READ_ONLY_DIRS, neutralizeScripts } from './core.ts';
import { compare, readText } from './python.ts';
import { markdownFiles } from './vault-notes.ts';

const LOG_RETENTION_MS = 30 * 24 * 3600 * 1000;
const UNTOUCHED_DIRS = [...READ_ONLY_DIRS, '.git', '.state'];
// Obsidian doesn't inherit the login shell's PATH; these match run.sh.
const TOOL_DIRS = [
  join(homedir(), '.local/bin'),
  join(homedir(), 'homebrew/bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];
const PROBE_SIGNAL = 0;

const execFileAsync = promisify(execFile);

export class LockedError extends Error {}

/** The environment for `claude` and `git`, with their usual folders on PATH. */
export function childEnv(): NodeJS.ProcessEnv {
  const path = [...TOOL_DIRS, process.env.PATH].filter(Boolean);
  return { ...process.env, PATH: path.join(delimiter) };
}

export function readJson<Data>(path: string, fallback: Data): Data {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}

/** Atomic write, so a reader such as the status bar never sees half a file. */
export function writeJson(path: string, data: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(temporary, path);
}

export async function git(vault: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', vault, ...args], {
    env: childEnv(),
  });
  return stdout.trim();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, PROBE_SIGNAL);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The live process holding the run lock, or null when nobody does. */
export function lockHolder(lock: string): number | null {
  const pidFile = join(lock, 'pid');
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  return Number.isInteger(pid) && isAlive(pid) ? pid : null;
}

/** Drop a lock this process holds; call it only when no run is under way. */
export function releaseOwnLock(lock: string): void {
  if (lockHolder(lock) === process.pid) {
    rmSync(lock, { recursive: true, force: true });
  }
}

function reclaim(lock: string): void {
  const holder = lockHolder(lock);
  // This process runs one job at a time, so its own pid marks a lock that a
  // reloaded window left behind.
  if (holder !== null && holder !== process.pid) {
    throw new LockedError(`Another run is in progress (pid ${holder}).`);
  }
  rmSync(lock, { recursive: true, force: true });
  mkdirSync(lock);
}

function claim(lock: string): void {
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    reclaim(lock);
  }
  writeFileSync(join(lock, 'pid'), String(process.pid));
}

/** Hold the directory lock the script engine also uses while `work` runs. */
export async function withLock<Result>(
  lock: string,
  work: () => Promise<Result>,
): Promise<Result> {
  claim(lock);
  try {
    return await work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export async function commitVault(
  vault: string,
  message: string,
): Promise<string | null> {
  if (!existsSync(join(vault, '.git'))) return null;
  try {
    if (!(await git(vault, 'status', '--porcelain'))) return null;
    await git(vault, 'add', '-A');
    await git(vault, 'commit', '-qm', message);
    return await git(vault, 'rev-parse', '--short', 'HEAD');
  } catch (error) {
    console.warn('erebor: vault commit failed', error);
    return null;
  }
}

export function pruneLogs(logDir: string): void {
  const cutoff = Date.now() - LOG_RETENTION_MS;
  for (const name of readdirSync(logDir)) {
    const log = join(logDir, name);
    if (statSync(log).mtimeMs < cutoff) unlinkSync(log);
  }
}

/** Disable code blocks in notes ingest may write; return what changed. */
export function neutralizeNotes(vault: string): string[] {
  const changed: string[] = [];
  for (const path of markdownFiles(vault, '', UNTOUCHED_DIRS)) {
    const text = readText(join(vault, path));
    const safe = neutralizeScripts(text);
    if (safe === text) continue;
    writeFileSync(join(vault, path), safe);
    changed.push(path);
  }
  return changed.sort(compare);
}
