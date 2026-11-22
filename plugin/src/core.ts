/** Pure logic for an ingest run: time windows, prompts, the run's outcome. */

import { BOUNDARY, SPACE, jsonDumps } from './python.ts';
import type {
  Catalog,
  Outcome,
  Planned,
  RunResult,
  SourceReport,
  Summary,
  Tokens,
  UpkeepRun,
  Usage,
  Window,
} from './types.ts';

export const READ_ONLY_DIRS = ['.claude', '.obsidian', 'dashboards', 'index'];
export const NOT_REPORTED = 'Not reported by the run';
const BUILTIN_TOOLS = ['Read', 'Glob', 'Grep', 'ToolSearch'];
// The script parses cursors with this exact shape: seconds, no fraction.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ISO_SECONDS_LENGTH = '2026-01-01T00:00:00'.length;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// Re-read the last hour so items straddling the previous run aren't missed.
const CURSOR_OVERLAP_MS = HOUR_MS;
const DEFAULT_INITIAL_DAYS = 3;
const DEFAULT_MAX_DAYS = 7;
const SCRIPT_FENCE = new RegExp(
  `(?<![^\\n])([${SPACE}]*(?:\`{3,}|~{3,})[${SPACE}]*)dataviewjs${BOUNDARY}`,
  'gu',
);
const TOKEN_UNITS: [number, string][] = [
  [1_000_000, 'M'],
  [1_000, 'K'],
];
const COMPACT_DIGITS = 3;

export class UsageError extends Error {}

export function toIso(moment: Date): string {
  return `${moment.toISOString().slice(0, ISO_SECONDS_LENGTH)}Z`;
}

export function fromIso(text: string): Date {
  if (!ISO_TIMESTAMP.test(text)) {
    throw new UsageError(`Not a UTC timestamp: '${text}'`);
  }
  return new Date(text);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function localDate(moment: Date): string {
  const month = pad(moment.getMonth() + 1);
  return `${moment.getFullYear()}-${month}-${pad(moment.getDate())}`;
}

export function runIdFor(moment: Date): string {
  const time = [moment.getHours(), moment.getMinutes(), moment.getSeconds()];
  return `${localDate(moment)}T${time.map(pad).join('')}`;
}

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/** Fetch window start: an override wins, then the cursor, capped. */
export function computeSince(
  cursor: string | undefined,
  now: Date,
  window: Window,
): string {
  if (window.overrideDays !== undefined) {
    return toIso(daysBefore(now, window.overrideDays));
  }
  if (!cursor) {
    const initialDays = window.initial_lookback_days ?? DEFAULT_INITIAL_DAYS;
    return toIso(daysBefore(now, initialDays));
  }
  const maxDays = window.max_lookback_days ?? DEFAULT_MAX_DAYS;
  const floor = daysBefore(now, maxDays).getTime();
  const rewound = fromIso(cursor).getTime() - CURSOR_OVERLAP_MS;
  return toIso(new Date(Math.max(rewound, floor)));
}

/** Read-only connector tools for the sources, plus vault-confined edits. */
export function allowedTools(
  vault: string,
  sourceNames: string[],
  catalog: Catalog,
): string[] {
  // `//` marks an absolute path in Claude Code permission rules.
  const tools = [...BUILTIN_TOOLS, `Edit(/${vault}/**)`];
  for (const name of sourceNames) {
    if (!(name in catalog)) {
      throw new UsageError(`unknown source '${name}' (see sources.json)`);
    }
    if (catalog[name].tools.length === 0) {
      throw new UsageError(
        `source '${name}' has no tools configured in sources.json`,
      );
    }
    tools.push(...catalog[name].tools);
  }
  return tools;
}

/** Keep settings, plugins, dashboards and the index read-only. */
export function disallowedTools(vault: string, allowed: string[]): string[] {
  // Project settings in .claude/ would widen the next run's permissions.
  const blocked = READ_ONLY_DIRS.map(
    (folder) => `Edit(/${vault}/${folder}/**)`,
  );
  // Claude Code runs read-only commands such as `cat` without an allow rule.
  const needsShell = allowed.some((tool) => tool.startsWith('Bash('));
  return needsShell ? blocked : [...blocked, 'Bash'];
}

/** Disable DataviewJS blocks and inline queries, which run as code. */
export function neutralizeScripts(text: string): string {
  return text.replace(SCRIPT_FENCE, '$1text').replaceAll('`$=', '`$ =');
}

export function renderSources(planned: Planned, catalog: Catalog): string {
  const sections = Object.entries(planned).map(
    ([name, plan]) =>
      `### ${name}\n\n- since: \`${plan.since}\`\n` +
      `- options: \`${jsonDumps(plan.options)}\`\n\n` +
      `${catalog[name].instructions}\n`,
  );
  return sections.join('\n');
}

export function renderPrompt(
  template: string,
  values: Record<string, string>,
): string {
  return Object.entries(values).reduce(
    // A function, so a `$` in the value isn't read as a replacement pattern.
    (text, [key, value]) => text.replaceAll(`@@${key}@@`, () => value),
    template,
  );
}

export function isResultForRun(
  result: unknown,
  runId: string,
): result is RunResult {
  const isObject = typeof result === 'object' && result !== null;
  return isObject && (result as RunResult).runId === runId;
}

/** Input includes cache reads and writes, which the API counts apart. */
export function tokenCounts(usage: Usage = {}): Tokens {
  const cached = usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  return {
    input: (usage.input_tokens ?? 0) + written + cached,
    cached,
    output: usage.output_tokens ?? 0,
  };
}

/** A source marked ok that still reports a problem keeps its cursor. */
export function fetchedFully(source: SourceReport): boolean {
  return source.ok === true && !source.error;
}

function runStatus(
  sources: SourceReport[],
  outcome: Outcome,
): Summary['status'] {
  const okCount = sources.filter((source) => source.ok === true).length;
  if (outcome.failure || okCount === 0) return 'failed';
  const isComplete = sources.every(fetchedFully) && outcome.exitCode === 0;
  return isComplete ? 'ok' : 'partial';
}

/** Merge the plan, Claude's result file and process outcome into a status. */
export function summarizeRun(
  planned: Planned,
  result: RunResult | null,
  outcome: Outcome,
): Summary {
  const reported = result?.sources ?? {};
  const sources: Record<string, SourceReport> = {};
  for (const [name, plan] of Object.entries(planned)) {
    const report = reported[name] ?? { ok: false, error: NOT_REPORTED };
    sources[name] = { ...report, since: plan.since };
  }
  return {
    status: runStatus(Object.values(sources), outcome),
    error: outcome.failure || null,
    exitCode: outcome.exitCode,
    sources,
    topicsUpdated: result?.topics_updated ?? [],
    topicsProposed: result?.topics_proposed ?? [],
    areasUpdated: result?.areas_updated ?? [],
    summary: result?.summary ?? null,
    costUsd: outcome.claude.total_cost_usd ?? null,
    tokens: tokenCounts(outcome.claude.usage),
    permissionDenials: outcome.claude.permission_denials?.length ?? 0,
  };
}

/** Fold the upkeep pass into a run's summary: its cost and outcome count. */
export function mergeUpkeep(summary: Summary, upkeep: UpkeepRun): Summary {
  const tokens = tokenCounts(upkeep.claude.usage);
  const upkeepCost = upkeep.claude.total_cost_usd ?? null;
  const costs = [summary.costUsd, upkeepCost].filter((cost) => cost !== null);
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  const hasFailedOkRun = summary.status === 'ok' && !upkeep.ok;
  return {
    ...summary,
    status: hasFailedOkRun ? 'partial' : summary.status,
    costUsd: costs.length > 0 ? total : null,
    tokens: {
      input: summary.tokens.input + tokens.input,
      cached: summary.tokens.cached + tokens.cached,
      output: summary.tokens.output + tokens.output,
    },
    upkeep: { topics: upkeep.topics, ok: upkeep.ok },
  };
}

/** A run that wrote code into notes is at best partial. */
export function flagScripts(summary: Summary, notes: string[]): Summary {
  const status = summary.status === 'ok' ? 'partial' : summary.status;
  return { ...summary, status, scriptsNeutralized: notes };
}

export function succeededSources(summary: Summary): string[] {
  const names = Object.keys(summary.sources);
  return names.filter((name) => fetchedFully(summary.sources[name]));
}

function compact(count: number): string {
  const unit = TOKEN_UNITS.find(([size]) => count >= size);
  if (!unit) return String(count);
  const [size, suffix] = unit;
  return `${Number((count / size).toPrecision(COMPACT_DIGITS))}${suffix}`;
}

function costLines(summary: Summary): string[] {
  if (summary.costUsd === null) return [];
  const { input, cached, output } = summary.tokens;
  return [
    `  cost: $${summary.costUsd.toFixed(2)} · ${compact(input)} tokens in ` +
      `(${compact(cached)} cached), ${compact(output)} out`,
  ];
}

function sourceLine(name: string, source: SourceReport): string {
  if (!source.ok) return `  ✗ ${name}  ${source.error || 'failed'}`;
  const detail =
    `${source.items_seen ?? 0} seen, ` +
    `${source.notes_written ?? 0} written, ` +
    `${source.notes_updated ?? 0} updated`;
  if (source.error) return `  ⚠ ${name}  ${detail} · ${source.error}`;
  return `  ✓ ${name}  ${detail}`;
}

export function formatReport(summary: Summary): string {
  const { upkeep, scriptsNeutralized, lintEntries } = summary;
  const headline = summary.summary || summary.error || '';
  const lines = [`\n${summary.status.toUpperCase()}  ${headline}`];
  for (const [name, source] of Object.entries(summary.sources)) {
    lines.push(sourceLine(name, source));
  }
  if (scriptsNeutralized?.length) {
    const notes = scriptsNeutralized.join(', ');
    lines.push(`  ⚠ disabled script blocks in: ${notes}`);
  }
  if (upkeep) {
    const mark = upkeep.ok ? '✓' : '✗';
    lines.push(`  ${mark} upkeep  ${upkeep.topics.join(', ')}`);
  }
  if (lintEntries) {
    lines.push(`  ⚑ ${lintEntries} entries to tidy in index/lint.md`);
  }
  return [...lines, ...costLines(summary)].join('\n');
}
