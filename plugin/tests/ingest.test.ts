import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { type TestContext, describe, it } from 'node:test';

import { UsageError } from '../src/core.ts';
import { ingest, upkeepOnly } from '../src/ingest.ts';
import { claudeCommand, loadSetup } from '../src/plan.ts';
import { findClaude } from '../src/runner.ts';
import { LockedError, git } from '../src/vault-files.ts';
import {
  REPO,
  fakeClaudeMode,
  holdLock,
  readState,
  scaffold,
  tempDir,
  writeFiles,
} from './helpers.ts';

const SCRIPT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function upkeepPrompts(state: string): string[] {
  const logs = join(state, 'logs');
  return readdirSync(logs)
    .filter((name) => name.endsWith('.upkeep.prompt.md'))
    .map((name) => readFileSync(join(logs, name), 'utf8'));
}

function markSeedTopicPromoted(vault: string): void {
  const note = join(vault, 'topics/checkout-redesign.md');
  const text = readFileSync(note, 'utf8');
  writeFileSync(note, text.replace('status:', 'promoted: 2099-01-01\nstatus:'));
}

describe('an ingest run', () => {
  it('reports ok when every source succeeds', async (t) => {
    const { setup, state } = scaffold(t);
    await ingest(setup);
    assert.equal(readState(state, 'last-run.json').status, 'ok');
  });

  it('advances every cursor', async (t) => {
    const { setup, state } = scaffold(t);
    await ingest(setup);
    const cursors = Object.keys(readState(state, 'cursor.json'));
    assert.deepEqual(cursors.sort(), ['fellow', 'linear']);
  });

  it('writes cursors in the format the script parses', async (t) => {
    const { setup, state } = scaffold(t);
    await ingest(setup);
    assert.match(readState(state, 'cursor.json').fellow, SCRIPT_TIMESTAMP);
  });

  it('commits the vault', async (t) => {
    const { setup, state } = scaffold(t);
    await ingest(setup);
    assert.notEqual(readState(state, 'last-run.json').commit, null);
  });

  it('records the plugin as its engine', async (t) => {
    const { setup, state } = scaffold(t);
    await ingest(setup);
    assert.equal(readState(state, 'last-run.json').engine, 'plugin');
  });

  it('fetches only the source it was asked for', async (t) => {
    const { setup, state } = scaffold(t);
    await ingest(setup, { sources: ['linear'] });
    assert.deepEqual(Object.keys(readState(state, 'cursor.json')), ['linear']);
  });

  it('is partial when a source fails', async (t) => {
    const { setup } = scaffold(t);
    fakeClaudeMode(t, 'partial');
    assert.equal((await ingest(setup)).status, 'partial');
  });

  it('advances only the cursors of sources that succeeded', async (t) => {
    const { setup, state } = scaffold(t);
    fakeClaudeMode(t, 'partial');
    await ingest(setup);
    assert.deepEqual(Object.keys(readState(state, 'cursor.json')), ['fellow']);
  });

  it('is partial when a source marked ok reports a problem', async (t) => {
    const { setup } = scaffold(t);
    fakeClaudeMode(t, 'caveat');
    assert.equal((await ingest(setup)).status, 'partial');
  });

  it('keeps the cursor of a source that reports a problem', async (t) => {
    const { setup, state } = scaffold(t);
    fakeClaudeMode(t, 'caveat');
    await ingest(setup);
    assert.deepEqual(Object.keys(readState(state, 'cursor.json')), ['fellow']);
  });

  it('fails when Claude writes no result file', async (t) => {
    const { setup } = scaffold(t);
    fakeClaudeMode(t, 'silent');
    const lastRun = await ingest(setup);
    assert.match(lastRun.error ?? '', /result file/);
  });

  it('keeps the cursors when Claude writes no result file', async (t) => {
    const { setup, state } = scaffold(t);
    fakeClaudeMode(t, 'silent');
    await ingest(setup);
    assert.deepEqual(readState(state, 'cursor.json'), {});
  });

  it('appends each run to the history', async (t) => {
    const { setup, state } = scaffold(t);
    await ingest(setup);
    await ingest(setup);
    const history = readFileSync(join(state, 'history.jsonl'), 'utf8');
    assert.equal(history.trim().split('\n').length, 2);
  });

  it('reports the tools Claude calls', async (t) => {
    const { setup } = scaffold(t);
    const called: string[] = [];
    await ingest(setup, { onProgress: (name) => called.push(name) });
    assert.deepEqual(called, ['Fellow_ai__search_meetings']);
  });

  it('neutralizes script blocks Claude wrote', async (t) => {
    const { setup, vault } = scaffold(t);
    fakeClaudeMode(t, 'script');
    await ingest(setup);
    const note = join(vault, 'sources/fellow/2026-11-02-eng-sync.md');
    assert.ok(!readFileSync(note, 'utf8').includes('dataviewjs'));
  });

  it('is partial when it had to neutralize scripts', async (t) => {
    const { setup } = scaffold(t);
    fakeClaudeMode(t, 'script');
    assert.equal((await ingest(setup)).status, 'partial');
  });

  it('gives Claude a fresh index to start from', async (t) => {
    const { setup } = scaffold(t);
    const lastRun = await ingest(setup);
    assert.match(lastRun.summary ?? '', /Saw the index/);
  });

  it('indexes the notes written during the run', async (t) => {
    const { setup, vault } = scaffold(t);
    await ingest(setup);
    const lint = readFileSync(join(vault, 'index/lint.md'), 'utf8');
    assert.ok(lint.includes('[[2026-11-02-eng-sync]]'));
  });

  it('reports how much there is to tidy', async (t) => {
    const { setup } = scaffold(t);
    assert.ok((await ingest(setup)).lintEntries > 0);
  });
});

describe('a cancelled run', () => {
  async function cancelledRun(t: TestContext) {
    const { setup, state } = scaffold(t);
    const lastRun = await ingest(setup, { signal: AbortSignal.abort() });
    return { lastRun, state };
  }

  it('fails as cancelled', async (t) => {
    const { lastRun } = await cancelledRun(t);
    assert.deepEqual([lastRun.status, lastRun.error], ['failed', 'Cancelled']);
  });

  it('leaves the cursors where they were', async (t) => {
    const { state } = await cancelledRun(t);
    assert.ok(!existsSync(join(state, 'cursor.json')));
  });

  it('releases the lock', async (t) => {
    const { state } = await cancelledRun(t);
    assert.ok(!existsSync(join(state, 'run.lock')));
  });
});

describe('the run lock', () => {
  it('refuses a run while another process holds it', async (t) => {
    const { setup, state } = scaffold(t);
    holdLock(state, process.ppid);
    await assert.rejects(ingest(setup), LockedError);
  });

  it('is reclaimed from a process that is gone', async (t) => {
    const { setup, state } = scaffold(t);
    holdLock(state, spawnSync('true').pid);
    assert.equal((await ingest(setup)).status, 'ok');
  });

  it('is reclaimed when this process left it behind', async (t) => {
    const { setup, state } = scaffold(t);
    holdLock(state, process.pid);
    assert.equal((await ingest(setup)).status, 'ok');
  });
});

describe('the upkeep pass', () => {
  it('is told which topics to promote', async (t) => {
    const { setup, state } = scaffold(t);
    await ingest(setup);
    assert.ok(upkeepPrompts(state)[0].includes('[[checkout-redesign]]'));
  });

  it('has what it writes indexed', async (t) => {
    const { setup, vault } = scaffold(t);
    await ingest(setup);
    const map = readFileSync(join(vault, 'index/map.md'), 'utf8');
    assert.ok(map.includes('[[from-upkeep]]'));
  });

  it('adds its cost to the run', async (t) => {
    const { setup } = scaffold(t);
    const cost = (await ingest(setup)).costUsd ?? 0;
    assert.equal(cost.toFixed(2), '0.03');
  });

  it('makes the run partial when it fails', async (t) => {
    const { setup } = scaffold(t);
    fakeClaudeMode(t, 'upkeep-fails');
    assert.equal((await ingest(setup)).status, 'partial');
  });

  it('is skipped when every topic is promoted', async (t) => {
    const { setup, vault, state } = scaffold(t);
    markSeedTopicPromoted(vault);
    await ingest(setup);
    assert.deepEqual(upkeepPrompts(state), []);
  });

  it('is skipped after a run without a result', async (t) => {
    const { setup, state } = scaffold(t);
    fakeClaudeMode(t, 'silent');
    await ingest(setup);
    assert.deepEqual(upkeepPrompts(state), []);
  });
});

describe('upkeep on its own', () => {
  it('runs the pass', async (t) => {
    const { setup, state } = scaffold(t);
    await upkeepOnly(setup);
    assert.equal(upkeepPrompts(state).length, 1);
  });

  it('fetches no sources', async (t) => {
    const { setup, state } = scaffold(t);
    await upkeepOnly(setup);
    assert.ok(!existsSync(join(state, 'cursor.json')));
  });

  it('commits what the pass wrote', async (t) => {
    const { setup, vault } = scaffold(t);
    await upkeepOnly(setup);
    assert.equal(await git(vault, 'status', '--porcelain'), '');
  });

  it('reports a failed pass', async (t) => {
    const { setup } = scaffold(t);
    fakeClaudeMode(t, 'upkeep-fails');
    assert.equal((await upkeepOnly(setup))?.ok, false);
  });

  it('has nothing to do when every topic is promoted', async (t) => {
    const { setup, vault } = scaffold(t);
    markSeedTopicPromoted(vault);
    assert.equal(await upkeepOnly(setup), null);
  });
});

describe('setup', () => {
  it('asks for a config when there is none', (t) => {
    const missing = join(tempDir(t), 'config.json');
    assert.throws(() => loadSetup(REPO, missing), UsageError);
  });

  it('refuses a folder the script has not set up as a vault', (t) => {
    const folder = tempDir(t);
    writeFiles(folder, {
      'config.json': JSON.stringify({ vault: folder, sources: {} }),
    });
    assert.throws(
      () => loadSetup(REPO, join(folder, 'config.json')),
      /isn't set up as a vault/,
    );
  });

  it('finds claude on the PATH when the config names none', (t) => {
    const folder = tempDir(t);
    writeFiles(folder, { claude: '#!/bin/sh\n' });
    chmodSync(join(folder, 'claude'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${path}${delimiter}${folder}`;
    t.after(() => {
      process.env.PATH = path;
    });
    const found = findClaude({ vault: folder, sources: {} });
    assert.equal(basename(found), 'claude');
  });
});

describe('the Claude command', () => {
  it('reads only project settings, so user settings cannot widen it', () => {
    const config = { vault: '/v', claude_bin: 'claude', sources: {} };
    const command = claudeCommand(config, ['Read']);
    const flag = command.indexOf('--setting-sources');
    assert.equal(command[flag + 1], 'project');
  });
});
