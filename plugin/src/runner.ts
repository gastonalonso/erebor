/** Runs `claude -p` as a child process and interprets how it ended. */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { constants as osConstants } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';

import { UsageError } from './core.ts';
import type { ClaudeResult, Config, RunResult } from './types.ts';
import { childEnv } from './vault-files.ts';

const CONNECTOR_PREFIX = /^mcp__claude_ai_/;
const STDERR_TAIL = 500;

export interface RunHooks {
  signal?: AbortSignal;
  onProgress?: (toolName: string) => void;
}

export interface ClaudeJob extends RunHooks {
  command: string[];
  prompt: string;
  vault: string;
  logDir: string;
  runId: string;
}

export interface ClaudeRun {
  exitCode: number;
  cancelled: boolean;
  claude: ClaudeResult;
  logFile: string;
  stderr: string;
}

interface StreamEvent extends ClaudeResult {
  message?: { content?: { type?: string; name?: string }[] };
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findClaude(config: Config): string {
  const folders = (childEnv().PATH ?? '').split(delimiter);
  const claude =
    config.claude_bin ||
    folders.map((folder) => join(folder, 'claude')).find(isExecutable);
  if (!claude) {
    throw new UsageError('claude not found; set claude_bin in config.json');
  }
  return claude;
}

function parseEvent(line: string): StreamEvent {
  try {
    const event: unknown = JSON.parse(line);
    return typeof event === 'object' && event !== null ? event : {};
  } catch {
    return {};
  }
}

function toolNames(event: StreamEvent): string[] {
  if (event.type !== 'assistant') return [];
  return (event.message?.content ?? [])
    .filter((block) => block.type === 'tool_use')
    .map((block) => (block.name ?? '').replace(CONNECTOR_PREFIX, ''));
}

/** Log every event, report tool calls, return the final result event. */
async function streamEvents(
  lines: AsyncIterable<string>,
  log: number,
  onProgress: RunHooks['onProgress'],
): Promise<ClaudeResult> {
  let result: ClaudeResult = {};
  for await (const line of lines) {
    writeSync(log, `${line}\n`);
    const event = parseEvent(line);
    if (event.type === 'result') result = event;
    for (const name of toolNames(event)) onProgress?.(name);
  }
  return result;
}

// A process a signal ended reports no code; the script engine records -signal.
function exitCodeOf(
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  return code ?? -(signal ? osConstants.signals[signal] : 1);
}

/** Run Claude, streaming events to a log; aborting the signal cancels it. */
export async function runClaude(job: ClaudeJob): Promise<ClaudeRun> {
  const logFile = join(job.logDir, `${job.runId}.jsonl`);
  const stderrFile = join(job.logDir, `${job.runId}.stderr`);
  const log = openSync(logFile, 'w');
  const stderr = openSync(stderrFile, 'w');
  let cancelled = false;
  try {
    const [binary, ...args] = job.command;
    const child = spawn(binary, args, {
      cwd: job.vault,
      env: childEnv(),
      stdio: ['pipe', 'pipe', stderr],
    });
    const cancel = () => {
      cancelled = true;
      child.kill();
    };
    if (job.signal?.aborted) cancel();
    job.signal?.addEventListener('abort', cancel, { once: true });
    // 'pipe' guarantees both streams; passing stderr as a file descriptor
    // hides that from the types.
    const stdin = child.stdin!;
    const stdout = child.stdout!;
    // A child that exits before reading its prompt says so in its exit code.
    stdin.on('error', () => undefined);
    stdin.end(job.prompt);
    const lines = createInterface({ input: stdout });
    const [claude, [code, signal]] = await Promise.all([
      streamEvents(lines, log, job.onProgress),
      once(child, 'close'),
    ]);
    job.signal?.removeEventListener('abort', cancel);
    const tail = readFileSync(stderrFile, 'utf8').slice(-STDERR_TAIL);
    const exitCode = exitCodeOf(code, signal);
    return { exitCode, cancelled, claude, logFile, stderr: tail };
  } finally {
    closeSync(log);
    closeSync(stderr);
  }
}

export function failureReason(
  run: ClaudeRun,
  result: RunResult | null,
): string | null {
  if (run.cancelled) return 'Cancelled';
  if (result !== null) return null;
  if (run.claude.is_error) return run.claude.result ?? null;
  return (
    run.stderr.trim() ||
    `Claude exited ${run.exitCode} without writing a result file`
  );
}
