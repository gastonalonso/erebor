import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type TestContext, describe, it } from 'node:test';

import { isInNoteFolder, refreshIndex } from '../src/live-index.ts';
import { releaseOwnLock } from '../src/vault-files.ts';
import { holdLock, tempDir, writeFiles } from './helpers.ts';

function vaultWithTopic(t: TestContext): string {
  const vault = tempDir(t);
  writeFiles(vault, { 'topics/checkout.md': '---\nstatus: active\n---\n' });
  return vault;
}

describe('isInNoteFolder', () => {
  it('takes a topic note', () => {
    assert.ok(isInNoteFolder('topics/checkout.md'));
  });

  it('takes a note nested under sources', () => {
    assert.ok(isInNoteFolder('sources/linear/ENG-1.md'));
  });

  it('leaves out the generated index', () => {
    assert.ok(!isInNoteFolder('index/map.md'));
  });

  it('leaves out a note at the vault root', () => {
    assert.ok(!isInNoteFolder('inbox.md'));
  });
});

describe('refreshIndex', () => {
  it('rebuilds the index', (t) => {
    const vault = vaultWithTopic(t);
    refreshIndex(vault);
    assert.ok(existsSync(join(vault, 'index/map.md')));
  });

  it('leaves the index to a run that holds the lock', (t) => {
    const vault = vaultWithTopic(t);
    holdLock(join(vault, '.state'), process.ppid);
    refreshIndex(vault);
    assert.ok(!existsSync(join(vault, 'index/map.md')));
  });

  it('says whether it rebuilt', (t) => {
    const vault = vaultWithTopic(t);
    holdLock(join(vault, '.state'), process.ppid);
    assert.equal(refreshIndex(vault), false);
  });
});

describe('releaseOwnLock', () => {
  it('removes a lock this process left behind', (t) => {
    const state = join(tempDir(t), '.state');
    holdLock(state, process.pid);
    releaseOwnLock(join(state, 'run.lock'));
    assert.ok(!existsSync(join(state, 'run.lock')));
  });

  it('keeps a lock another process holds', (t) => {
    const state = join(tempDir(t), '.state');
    holdLock(state, process.ppid);
    releaseOwnLock(join(state, 'run.lock'));
    assert.ok(existsSync(join(state, 'run.lock')));
  });
});
