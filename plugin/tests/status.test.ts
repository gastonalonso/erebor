import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { statusText } from '../src/status.ts';

const RUN_ID = '2026-11-18T135816';

describe('statusText', () => {
  it('says so when the vault has never been ingested', () => {
    assert.equal(statusText(null, false), 'Ingest: not run yet');
  });

  it('shows the outcome, start time and cost of the last run', () => {
    const lastRun = { runId: RUN_ID, status: 'partial', costUsd: 0.7801 };
    assert.equal(
      statusText(lastRun, false),
      'Ingest: partial · 11-18 13:58 · $0.78',
    );
  });

  it('leaves out a cost the run did not report', () => {
    const lastRun = { runId: RUN_ID, status: 'failed', costUsd: null };
    assert.equal(statusText(lastRun, false), 'Ingest: failed · 11-18 13:58');
  });

  it('shows a run in progress', () => {
    const lastRun = { runId: RUN_ID, status: 'running' };
    assert.equal(statusText(lastRun, true), 'Ingest: running');
  });

  it('shows the tool a run is calling', () => {
    const lastRun = { runId: RUN_ID, status: 'running' };
    assert.equal(
      statusText(lastRun, true, 'Linear__list_issues'),
      'Ingest: running · Linear__list_issues',
    );
  });

  it('calls a run interrupted when nothing holds its lock', () => {
    const lastRun = { runId: RUN_ID, status: 'running' };
    assert.equal(statusText(lastRun, false), 'Ingest: interrupted');
  });
});
