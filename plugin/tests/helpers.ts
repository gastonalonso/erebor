import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { TestContext } from 'node:test';

import { type Setup, loadSetup } from '../src/plan.ts';

export const REPO = resolve(import.meta.dirname, '../..');
const FAKE_CLAUDE = join(REPO, 'tests/fake_claude.py');
const DEFAULT_SOURCES = {
  fellow: { enabled: true },
  linear: { enabled: true },
};

Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});

export interface Scaffold {
  setup: Setup;
  vault: string;
  state: string;
  configFile: string;
}

export function tempDir(t: TestContext): string {
  const folder = mkdtempSync(join(tmpdir(), 'erebor-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** Run a Python snippet in the repo: JSON in on stdin, JSON out on stdout. */
export function python<Output>(code: string, input: unknown = null): Output {
  const output = execFileSync('python3', ['-c', code], {
    cwd: REPO,
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

/** Run the script engine with the fake Claude; return its exit code. */
export function runScript(configFile: string, ...args: string[]): number {
  const env = { ...process.env, EREBOR_CONFIG: configFile };
  const run = spawnSync('python3', [join(REPO, 'ingest.py'), ...args], { env });
  return run.status ?? -1;
}

/** A vault the script engine scaffolded, with a config pointing at it. */
export function scaffold(
  t: TestContext,
  sources: Record<string, object> = DEFAULT_SOURCES,
): Scaffold {
  const folder = tempDir(t);
  const vault = join(folder, 'vault');
  const configFile = join(folder, 'config.json');
  const config = {
    vault,
    claude_bin: FAKE_CLAUDE,
    seed_topics: ['Checkout Redesign'],
    sources,
  };
  writeFileSync(configFile, JSON.stringify(config));
  runScript(configFile, '--init');
  const setup = loadSetup(REPO, configFile);
  return { setup, vault, state: join(vault, '.state'), configFile };
}

/** Make it look as if the process `pid` is in the middle of a run. */
export function holdLock(state: string, pid: number): void {
  writeFiles(state, { 'run.lock/pid': String(pid) });
}

/** Choose how the fake Claude behaves for the rest of this test. */
export function fakeClaudeMode(t: TestContext, mode: string): void {
  process.env.FAKE_CLAUDE_MODE = mode;
  t.after(() => delete process.env.FAKE_CLAUDE_MODE);
}

export function readState<Data = Record<string, any>>(
  state: string,
  name: string,
): Data {
  return JSON.parse(readFileSync(join(state, name), 'utf8'));
}
