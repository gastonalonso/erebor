/** The shapes of a run: its config, its plan and what came of it. */

export type SourceOptions = Record<string, unknown>;

export interface Config {
  vault: string;
  claude_bin?: string;
  model?: string;
  initial_lookback_days?: number;
  max_lookback_days?: number;
  exclusions?: string[];
  sources: Record<string, SourceOptions>;
}

/** The lookback settings of a config, plus a one-off override. */
export interface Window {
  initial_lookback_days?: number;
  max_lookback_days?: number;
  overrideDays?: number;
}

export type Catalog = Record<string, { tools: string[]; instructions: string }>;
export type Planned = Record<string, { since: string; options: SourceOptions }>;

export interface SourceReport {
  ok?: boolean;
  error?: string | null;
  since?: string;
  items_seen?: number;
  notes_written?: number;
  notes_updated?: number;
}

/** The result file Claude writes at the end of a run. */
export interface RunResult {
  runId?: string;
  sources?: Record<string, SourceReport>;
  topics_updated?: string[];
  topics_proposed?: string[];
  areas_updated?: string[];
  summary?: string;
}

export interface Usage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

/** The final `result` event of Claude's stream-json output. */
export interface ClaudeResult {
  type?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: Usage;
  permission_denials?: unknown[];
}

export interface Outcome {
  exitCode: number;
  failure: string | null;
  claude: ClaudeResult;
}

export interface Tokens {
  input: number;
  cached: number;
  output: number;
}

export interface UpkeepRun {
  topics: string[];
  ok: boolean;
  claude: ClaudeResult;
}

export interface Summary {
  status: 'ok' | 'partial' | 'failed';
  error: string | null;
  exitCode: number;
  sources: Record<string, SourceReport>;
  topicsUpdated: string[];
  topicsProposed: string[];
  areasUpdated: string[];
  summary: string | null;
  costUsd: number | null;
  tokens: Tokens;
  permissionDenials: number;
  upkeep?: { topics: string[]; ok: boolean };
  scriptsNeutralized?: string[];
  lintEntries?: number;
}
