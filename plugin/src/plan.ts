/** What a run will do: its sources and windows, its prompt and command. */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  UsageError,
  allowedTools,
  computeSince,
  disallowedTools,
  localDate,
  renderPrompt,
  renderSources,
  runIdFor,
  toIso,
} from './core.ts';
import { type RunHooks, findClaude } from './runner.ts';
import type { Catalog, Config, Planned, SourceOptions } from './types.ts';
import { readJson } from './vault-files.ts';

const HOME_PREFIX = /^~(?=$|\/)/;
const VAULT_RULES = '.claude/CLAUDE.md';

/** Where the prompts and source catalog live, and the user's config. */
export interface Setup {
  repoDir: string;
  config: Config;
}

export interface RunOptions extends RunHooks {
  sources?: string[];
  lookbackDays?: number;
}

export interface Plan {
  runId: string;
  startedAt: string;
  planned: Planned;
  tools: string[];
  prompt: string;
}

export function loadSetup(
  repoDir: string,
  configFile = join(repoDir, 'config.json'),
): Setup {
  if (!existsSync(configFile)) {
    throw new UsageError(
      `No config at ${configFile}. Run ./run.sh once to create it.`,
    );
  }
  const config: Config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.vault = config.vault.replace(HOME_PREFIX, homedir());
  if (!existsSync(join(config.vault, VAULT_RULES))) {
    throw new UsageError(
      `${config.vault} isn't set up as a vault. Run ./run.sh --init first.`,
    );
  }
  return { repoDir, config };
}

/** The state files both engines read and write. */
export function statePaths(vault: string) {
  const state = join(vault, '.state');
  return {
    logs: join(state, 'logs'),
    lock: join(state, 'run.lock'),
    cursors: join(state, 'cursor.json'),
    lastRun: join(state, 'last-run.json'),
    result: join(state, 'run-result.json'),
    history: join(state, 'history.jsonl'),
  };
}

function sourceOptions(config: Config, name: string): SourceOptions {
  const options = { ...config.sources[name] };
  delete options.enabled;
  return options;
}

function sourceNames(config: Config, options: RunOptions): string[] {
  if (options.sources?.length) return options.sources;
  const names = Object.keys(config.sources);
  return names.filter((name) => config.sources[name].enabled);
}

/** Which sources to fetch, since when, and the prompt and tools for it. */
export function planRun(
  setup: Setup,
  options: RunOptions = {},
  now = new Date(),
): Plan {
  const { repoDir, config } = setup;
  const paths = statePaths(config.vault);
  const catalog = readJson<Catalog>(join(repoDir, 'sources.json'), {});
  const names = sourceNames(config, options);
  if (names.length === 0) throw new UsageError('no sources enabled');
  const tools = allowedTools(config.vault, names, catalog);
  const cursors = readJson<Record<string, string>>(paths.cursors, {});
  const window = { ...config, overrideDays: options.lookbackDays };
  const planned: Planned = {};
  for (const name of names) {
    const since = computeSince(cursors[name], now, window);
    planned[name] = { since, options: sourceOptions(config, name) };
  }
  const runId = runIdFor(now);
  const exclusions = (config.exclusions ?? []).map((line) => `- ${line}`);
  const template = readFileSync(join(repoDir, 'prompt.md'), 'utf8');
  const prompt = renderPrompt(template, {
    RUN_ID: runId,
    VAULT: config.vault,
    NOW: toIso(now),
    RESULT_FILE: paths.result,
    TODAY: localDate(now),
    SOURCES: renderSources(planned, catalog),
    EXCLUSIONS: exclusions.join('\n') || 'None.',
  });
  return { runId, startedAt: toIso(now), planned, tools, prompt };
}

export function claudeCommand(config: Config, tools: string[]): string[] {
  const model = config.model ? ['--model', config.model] : [];
  // Only project settings (the vault has none), so the user's global allow
  // list can't widen what an unattended run may do.
  const flags = ['-p', '--setting-sources', 'project'];
  flags.push('--permission-mode', 'dontAsk');
  flags.push('--output-format', 'stream-json', '--verbose', ...model);
  flags.push('--disallowedTools', ...disallowedTools(config.vault, tools));
  // --allowedTools takes every argument after it, so it goes last.
  return [findClaude(config), ...flags, '--allowedTools', ...tools];
}
