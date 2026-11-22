/** Pull new items from work sources into the vault with `claude -p`. */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  allowedTools,
  flagScripts,
  isResultForRun,
  localDate,
  mergeUpkeep,
  runIdFor,
  succeededSources,
  summarizeRun,
  toIso,
} from './core.ts';
import {
  type Plan,
  type RunOptions,
  type Setup,
  claudeCommand,
  planRun,
  statePaths,
} from './plan.ts';
import { type RunHooks, failureReason, runClaude } from './runner.ts';
import type { RunResult, Summary, UpkeepRun } from './types.ts';
import { type UpkeepJob, runUpkeep } from './upkeep.ts';
import {
  commitVault,
  neutralizeNotes,
  pruneLogs,
  readJson,
  withLock,
  writeJson,
} from './vault-files.ts';
import { rebuild } from './vault-index.ts';

// Tells the plugin's runs from the script's in the status file and history.
const ENGINE = 'plugin';

export interface LastRun extends Summary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  lintEntries: number;
  logFile: string;
  commit: string | null;
  engine: string;
}

function readResult(path: string, runId: string): RunResult | null {
  try {
    const result: unknown = readJson(path, null);
    return isResultForRun(result, runId) ? result : null;
  } catch {
    // A result file that isn't JSON says as little as a missing one.
    return null;
  }
}

function upkeepJob(setup: Setup, runId: string, hooks: RunHooks): UpkeepJob {
  const { repoDir, config } = setup;
  // The upkeep pass reads no source, so it gets no source tools.
  const tools = allowedTools(config.vault, [], {});
  return {
    command: claudeCommand(config, tools),
    template: readFileSync(join(repoDir, 'upkeep.md'), 'utf8'),
    today: localDate(new Date()),
    vault: config.vault,
    logDir: statePaths(config.vault).logs,
    runId,
    signal: hooks.signal,
    onProgress: hooks.onProgress,
  };
}

function markRunning(vault: string, plan: Plan): void {
  const paths = statePaths(vault);
  writeFileSync(join(paths.logs, `${plan.runId}.prompt.md`), plan.prompt);
  rmSync(paths.result, { force: true });
  const sources: Record<string, { since: string }> = {};
  for (const [name, source] of Object.entries(plan.planned)) {
    sources[name] = { since: source.since };
  }
  writeJson(paths.lastRun, {
    runId: plan.runId,
    status: 'running',
    startedAt: plan.startedAt,
    sources,
    engine: ENGINE,
  });
}

function advanceCursors(vault: string, summary: Summary, to: string): void {
  const { cursors: file } = statePaths(vault);
  const cursors = readJson<Record<string, string>>(file, {});
  for (const name of succeededSources(summary)) cursors[name] = to;
  writeJson(file, cursors);
}

async function runLocked(
  setup: Setup,
  plan: Plan,
  hooks: RunHooks,
): Promise<LastRun> {
  const { vault } = setup.config;
  const paths = statePaths(vault);
  const { runId, startedAt, planned, prompt } = plan;
  const { signal, onProgress } = hooks;
  const command = claudeCommand(setup.config, plan.tools);
  markRunning(vault, plan);

  // Interactive sessions and the dashboard change notes between runs.
  rebuild(vault);
  const logDir = paths.logs;
  const job = { command, prompt, vault, logDir, runId, signal, onProgress };
  const run = await runClaude(job);
  const result = readResult(paths.result, runId);
  const shouldTidy = result !== null && !run.cancelled;
  const upkeep = shouldTidy
    ? await runUpkeep(upkeepJob(setup, runId, hooks))
    : null;
  const neutralized = neutralizeNotes(vault);
  const lintEntries = rebuild(vault);

  const failure = failureReason(run, result);
  const outcome = { exitCode: run.exitCode, failure, claude: run.claude };
  let summary = summarizeRun(planned, result, outcome);
  if (upkeep) summary = mergeUpkeep(summary, upkeep);
  if (neutralized.length > 0) summary = flagScripts(summary, neutralized);
  if (!run.cancelled) advanceCursors(vault, summary, startedAt);
  const final: LastRun = {
    runId,
    startedAt,
    finishedAt: toIso(new Date()),
    ...summary,
    lintEntries,
    logFile: run.logFile,
    commit: await commitVault(vault, `Ingest ${runId} (${summary.status})`),
    engine: ENGINE,
  };
  writeJson(paths.lastRun, final);
  appendFileSync(paths.history, `${JSON.stringify(final)}\n`);
  pruneLogs(paths.logs);
  return final;
}

export async function ingest(
  setup: Setup,
  options: RunOptions = {},
): Promise<LastRun> {
  const paths = statePaths(setup.config.vault);
  mkdirSync(paths.logs, { recursive: true });
  const plan = planRun(setup, options);
  return withLock(paths.lock, () => runLocked(setup, plan, options));
}

/** Run only the upkeep pass, as its own locked and committed run. */
export async function upkeepOnly(
  setup: Setup,
  hooks: RunHooks = {},
): Promise<UpkeepRun | null> {
  const { vault } = setup.config;
  const paths = statePaths(vault);
  mkdirSync(paths.logs, { recursive: true });
  const runId = runIdFor(new Date());
  const job = upkeepJob(setup, runId, hooks);
  return withLock(paths.lock, async () => {
    rebuild(vault);
    const outcome = await runUpkeep(job);
    neutralizeNotes(vault);
    rebuild(vault);
    await commitVault(vault, `Upkeep ${runId}`);
    return outcome;
  });
}
