import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as core from '../src/core.ts';
import type { SourceReport } from '../src/types.ts';

const NOW = new Date('2026-11-02T18:00:00Z');
const WINDOW = { initial_lookback_days: 3, max_lookback_days: 7 };
const CATALOG = {
  fellow: { tools: ['fellow_read'], instructions: 'Fellow rules.' },
  slack: { tools: [], instructions: 'Slack rules.' },
};
const PLANNED = {
  fellow: { since: '2026-11-01T00:00:00Z', options: {} },
  linear: { since: '2026-11-01T00:00:00Z', options: {} },
};
const CLEAN_EXIT = { exitCode: 0, failure: null, claude: {} };
const BOTH_OK = { fellow: { ok: true }, linear: { ok: true } };
const HALF_READ = { ok: true, error: 'half read' };

function resultWith(sources: Record<string, SourceReport>) {
  return { runId: 'r1', sources, summary: 'Did things.' };
}

describe('computeSince', () => {
  it('uses the initial lookback on a first run', () => {
    const since = core.computeSince(undefined, NOW, WINDOW);
    assert.equal(since, '2026-10-30T18:00:00Z');
  });

  it('rewinds the cursor by the overlap', () => {
    const since = core.computeSince('2026-11-02T12:00:00Z', NOW, WINDOW);
    assert.equal(since, '2026-11-02T11:00:00Z');
  });

  it('caps a stale cursor at the maximum lookback', () => {
    const since = core.computeSince('2026-09-01T00:00:00Z', NOW, WINDOW);
    assert.equal(since, '2026-10-26T18:00:00Z');
  });

  it('lets an override ignore the cursor and the cap', () => {
    const window = { ...WINDOW, overrideDays: 30 };
    const since = core.computeSince('2026-11-02T12:00:00Z', NOW, window);
    assert.equal(since, '2026-10-03T18:00:00Z');
  });

  it('rejects a cursor the script could not parse', () => {
    const withMillis = '2026-11-02T12:00:00.000Z';
    assert.throws(
      () => core.computeSince(withMillis, NOW, WINDOW),
      core.UsageError,
    );
  });
});

describe('timestamps', () => {
  it('are written to the second, as the script reads them', () => {
    const moment = new Date('2026-11-02T18:00:00.789Z');
    assert.equal(core.toIso(moment), '2026-11-02T18:00:00Z');
  });

  it('give a run an id from its local start time', () => {
    const moment = new Date(2026, 10, 2, 9, 5, 7);
    assert.equal(core.runIdFor(moment), '2026-11-02T090507');
  });
});

describe('allowedTools', () => {
  it('confines edits to the vault', () => {
    const tools = core.allowedTools('/v', ['fellow'], CATALOG);
    assert.ok(tools.includes('Edit(//v/**)'));
  });

  it('includes the source tools', () => {
    const tools = core.allowedTools('/v', ['fellow'], CATALOG);
    assert.ok(tools.includes('fellow_read'));
  });

  it('rejects an unknown source', () => {
    assert.throws(
      () => core.allowedTools('/v', ['jira'], CATALOG),
      /unknown source/,
    );
  });

  it('rejects a source without tools', () => {
    assert.throws(
      () => core.allowedTools('/v', ['slack'], CATALOG),
      /no tools/,
    );
  });
});

describe('disallowedTools', () => {
  it('blocks the shell when no source needs it', () => {
    assert.ok(core.disallowedTools('/v', ['Read']).includes('Bash'));
  });

  it('keeps the shell for sources that need commands', () => {
    const blocked = core.disallowedTools('/v', ['Read', 'Bash(gh pr view:*)']);
    assert.ok(!blocked.includes('Bash'));
  });

  it('keeps settings, plugins, dashboards and the index read-only', () => {
    const blocked = core.disallowedTools('/v', ['Read']);
    const expected = ['.claude', '.obsidian', 'dashboards', 'index'].map(
      (folder) => `Edit(//v/${folder}/**)`,
    );
    assert.deepEqual(blocked.slice(0, expected.length), expected);
  });
});

describe('neutralizeScripts', () => {
  it('turns a fenced dataviewjs block into plain text', () => {
    const text = 'a\n```dataviewjs\nalert(1)\n```\n';
    assert.equal(
      core.neutralizeScripts(text),
      'a\n```text\nalert(1)\n```\n',
    );
  });

  it('breaks an inline JavaScript query', () => {
    assert.equal(
      core.neutralizeScripts('x `$= alert(1)` y'),
      'x `$ = alert(1)` y',
    );
  });

  it('leaves plain dataview queries alone', () => {
    const text = '```dataview\nLIST\n```\n';
    assert.equal(core.neutralizeScripts(text), text);
  });
});

describe('rendering', () => {
  it('replaces a placeholder everywhere', () => {
    const rendered = core.renderPrompt('@@A@@ and @@A@@', { A: 'x' });
    assert.equal(rendered, 'x and x');
  });

  it('keeps a dollar sign in a value as it is', () => {
    const rendered = core.renderPrompt('@@A@@', { A: '$& costs $1' });
    assert.equal(rendered, '$& costs $1');
  });

  it('gives each source its since time', () => {
    const rendered = core.renderSources({ fellow: PLANNED.fellow }, CATALOG);
    assert.ok(rendered.includes('2026-11-01T00:00:00Z'));
  });

  it('gives each source its instructions', () => {
    const rendered = core.renderSources({ fellow: PLANNED.fellow }, CATALOG);
    assert.ok(rendered.includes('Fellow rules.'));
  });
});

describe('summarizeRun', () => {
  it('is ok when every source is ok', () => {
    const summary = core.summarizeRun(PLANNED, resultWith(BOTH_OK), CLEAN_EXIT);
    assert.equal(summary.status, 'ok');
  });

  it('is partial when one source failed', () => {
    const sources = { ...BOTH_OK, linear: { ok: false, error: 'auth' } };
    const summary = core.summarizeRun(PLANNED, resultWith(sources), CLEAN_EXIT);
    assert.equal(summary.status, 'partial');
  });

  it('is partial when a source marked ok reports a problem', () => {
    const sources = { ...BOTH_OK, linear: HALF_READ };
    const summary = core.summarizeRun(PLANNED, resultWith(sources), CLEAN_EXIT);
    assert.equal(summary.status, 'partial');
  });

  it('is partial when every source reports a problem', () => {
    const sources = { fellow: HALF_READ, linear: HALF_READ };
    const summary = core.summarizeRun(PLANNED, resultWith(sources), CLEAN_EXIT);
    assert.equal(summary.status, 'partial');
  });

  it('does not count a source that reports a problem as succeeded', () => {
    const sources = { ...BOTH_OK, linear: HALF_READ };
    const summary = core.summarizeRun(PLANNED, resultWith(sources), CLEAN_EXIT);
    assert.deepEqual(core.succeededSources(summary), ['fellow']);
  });

  it('counts an unreported source as failed', () => {
    const result = resultWith({ fellow: { ok: true } });
    const summary = core.summarizeRun(PLANNED, result, CLEAN_EXIT);
    assert.equal(summary.sources.linear.error, core.NOT_REPORTED);
  });

  it('downgrades ok to partial on a nonzero exit', () => {
    const outcome = { ...CLEAN_EXIT, exitCode: 1 };
    const summary = core.summarizeRun(PLANNED, resultWith(BOTH_OK), outcome);
    assert.equal(summary.status, 'partial');
  });

  it('fails with the reason when there is no result', () => {
    const outcome = { ...CLEAN_EXIT, failure: 'boom' };
    const summary = core.summarizeRun(PLANNED, null, outcome);
    assert.deepEqual([summary.status, summary.error], ['failed', 'boom']);
  });

  it('keeps since for each source', () => {
    const summary = core.summarizeRun(PLANNED, null, CLEAN_EXIT);
    assert.equal(summary.sources.fellow.since, '2026-11-01T00:00:00Z');
  });

  it('lists only ok sources as succeeded', () => {
    const sources = { fellow: { ok: true }, linear: { ok: false } };
    const summary = core.summarizeRun(PLANNED, resultWith(sources), CLEAN_EXIT);
    assert.deepEqual(core.succeededSources(summary), ['fellow']);
  });

  it('carries the updated areas into the summary', () => {
    const result = { ...resultWith(BOTH_OK), areas_updated: ['a'] };
    const summary = core.summarizeRun(PLANNED, result, CLEAN_EXIT);
    assert.deepEqual(summary.areasUpdated, ['a']);
  });

  it('rejects a result written for another run', () => {
    assert.equal(core.isResultForRun({ runId: 'old' }, 'new'), false);
  });
});

describe('formatReport', () => {
  it('points at lint when it has entries', () => {
    const summary = core.summarizeRun(PLANNED, null, CLEAN_EXIT);
    const report = core.formatReport({ ...summary, lintEntries: 4 });
    assert.ok(report.includes('4 entries to tidy in index/lint.md'));
  });

  it('shows the problem of a source marked ok', () => {
    const sources = { ...BOTH_OK, linear: HALF_READ };
    const summary = core.summarizeRun(PLANNED, resultWith(sources), CLEAN_EXIT);
    const expected = '⚠ linear  0 seen, 0 written, 0 updated · half read';
    assert.ok(core.formatReport(summary).includes(expected));
  });

  it('is quiet about an empty lint', () => {
    const summary = core.summarizeRun(PLANNED, null, CLEAN_EXIT);
    const report = core.formatReport({ ...summary, lintEntries: 0 });
    assert.ok(!report.includes('lint'));
  });
});

const UPKEEP = {
  topics: ['checkout'],
  ok: true,
  claude: { total_cost_usd: 0.5, usage: { output_tokens: 7 } },
};

function summaryBeforeUpkeep(failure: string | null = null) {
  const claude = { total_cost_usd: 1.0, usage: { output_tokens: 3 } };
  const outcome = { ...CLEAN_EXIT, claude, failure };
  return core.summarizeRun(PLANNED, resultWith(BOTH_OK), outcome);
}

describe('mergeUpkeep', () => {
  it('adds the upkeep cost to the run', () => {
    const merged = core.mergeUpkeep(summaryBeforeUpkeep(), UPKEEP);
    assert.equal(merged.costUsd, 1.5);
  });

  it('adds the upkeep tokens to the run', () => {
    const merged = core.mergeUpkeep(summaryBeforeUpkeep(), UPKEEP);
    assert.equal(merged.tokens.output, 10);
  });

  it('downgrades ok to partial when upkeep failed', () => {
    const failed = { ...UPKEEP, ok: false };
    const merged = core.mergeUpkeep(summaryBeforeUpkeep(), failed);
    assert.equal(merged.status, 'partial');
  });

  it('leaves a failed run failed', () => {
    const failed = { ...UPKEEP, ok: false };
    const merged = core.mergeUpkeep(summaryBeforeUpkeep('boom'), failed);
    assert.equal(merged.status, 'failed');
  });

  it('names the topics upkeep worked on in the report', () => {
    const merged = core.mergeUpkeep(summaryBeforeUpkeep(), UPKEEP);
    assert.ok(core.formatReport(merged).includes('✓ upkeep  checkout'));
  });
});

const USAGE_EVENT = {
  total_cost_usd: 1.0629942,
  usage: {
    input_tokens: 38,
    cache_creation_input_tokens: 159953,
    cache_read_input_tokens: 2308862,
    output_tokens: 19222,
  },
};

describe('usage', () => {
  it('counts cache reads and writes as input tokens', () => {
    const outcome = { ...CLEAN_EXIT, claude: USAGE_EVENT };
    const summary = core.summarizeRun(PLANNED, null, outcome);
    assert.deepEqual(summary.tokens, {
      input: 2468853,
      cached: 2308862,
      output: 19222,
    });
  });

  it('shows cost and tokens in the report', () => {
    const outcome = { ...CLEAN_EXIT, claude: USAGE_EVENT };
    const report = core.formatReport(core.summarizeRun(PLANNED, null, outcome));
    const expected = 'cost: $1.06 · 2.47M tokens in (2.31M cached), 19.2K out';
    assert.ok(report.includes(expected));
  });

  it('omits the cost when Claude reported none', () => {
    const summary = core.summarizeRun(PLANNED, null, CLEAN_EXIT);
    assert.ok(!core.formatReport(summary).includes('cost:'));
  });
});
