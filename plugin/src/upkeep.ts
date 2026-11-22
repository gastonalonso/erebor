/** The upkeep pass: a headless run that promotes topics and tidies lint. */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderPrompt } from './core.ts';
import { shown } from './python.ts';
import { type ClaudeJob, runClaude } from './runner.ts';
import type { UpkeepRun } from './types.ts';
import { Vault } from './vault.ts';
import { needsPromotion } from './vault-lint.ts';
import { type Note, load, printed } from './vault-notes.ts';

// A pass stays short; a backlog drains over the runs that follow.
const BATCH_SIZE = 5;

export interface UpkeepJob extends Omit<ClaudeJob, 'prompt'> {
  template: string;
  today: string;
}

/** The next topics to promote, archived ones first. */
export function queue(vault: string): Note[] {
  return needsPromotion(new Vault(load(vault))).slice(0, BATCH_SIZE);
}

function topicLine(topic: Note): string {
  const status = printed(topic, 'status');
  const promoted = shown(topic.meta.get('promoted')) || 'never';
  return `   - [[${topic.name}]] (${status}, promoted ${promoted})`;
}

export function upkeepPrompt(job: UpkeepJob, topics: Note[]): string {
  return renderPrompt(job.template, {
    RUN_ID: job.runId,
    VAULT: job.vault,
    TODAY: job.today,
    TOPICS: topics.map(topicLine).join('\n'),
  });
}

/** Promote the topics that need it; null when no topic does. */
export async function runUpkeep(job: UpkeepJob): Promise<UpkeepRun | null> {
  const topics = queue(job.vault);
  if (topics.length === 0) return null;
  const prompt = upkeepPrompt(job, topics);
  const runId = `${job.runId}.upkeep`;
  writeFileSync(join(job.logDir, `${runId}.prompt.md`), prompt);
  const outcome = await runClaude({ ...job, prompt, runId });
  const hasResult = Object.keys(outcome.claude).length > 0;
  const hasFinished = hasResult && !outcome.claude.is_error;
  return {
    topics: topics.map((topic) => topic.name),
    ok: outcome.exitCode === 0 && hasFinished,
    claude: outcome.claude,
  };
}
