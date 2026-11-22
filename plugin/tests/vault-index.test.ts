import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { jsonDumps } from '../src/python.ts';
import * as vaultIndex from '../src/vault-index.ts';
import { type Note, parseNote } from '../src/vault-notes.ts';
import { tempDir, writeFiles } from './helpers.ts';

type Fields = Record<string, string | string[]>;

function note(path: string, body = '', meta: Fields = {}): Note {
  const fields = Object.entries(meta).map(
    ([key, value]) => `${key}: ${jsonDumps(value)}\n`,
  );
  return parseNote(path, `---\n${fields.join('')}---\n${body}`);
}

function source(name: string, body = '', meta: Fields = {}): Note {
  const folder = String(meta.source ?? 'linear');
  const fields = { source: folder, title: name, ...meta };
  return note(`sources/${folder}/${name}.md`, body, fields);
}

function topic(name: string, body = '', meta: Fields = {}): Note {
  const fields = { status: 'active', description: `About ${name}`, ...meta };
  return note(`topics/${name}.md`, body, fields);
}

function area(name: string, body = '', meta: Fields = {}): Note {
  return note(`areas/${name}.md`, body, {
    description: `About ${name}`,
    ...meta,
  });
}

function person(slug: string, name: string, meta: Fields = {}): Note {
  return note(`people/${slug}.md`, '', { name, ...meta });
}

function index(...notes: Note[]): Record<string, string> {
  return vaultIndex.build(notes);
}

function lineFor(text: string, start: string): string {
  return text.split('\n').find((line) => line.startsWith(start)) ?? '';
}

describe('the map', () => {
  it('gives a topic line its description', () => {
    const text = index(topic('checkout'))['map.md'];
    assert.ok(lineFor(text, '- [[checkout]]').includes('About checkout'));
  });

  it('gives a topic line its aliases', () => {
    const text = index(topic('checkout', '', { aliases: ['Cart'] }))['map.md'];
    assert.ok(lineFor(text, '- [[checkout]]').includes('also: Cart'));
  });

  it('keeps an archived topic, with its status', () => {
    const text = index(topic('checkout', '', { status: 'archived' }))['map.md'];
    assert.ok(lineFor(text, '- [[checkout]]').includes('— archived —'));
  });

  it('lists a dropped topic with its reason', () => {
    const dropped = { status: 'dropped', description: 'split up' };
    const text = index(topic('q4', '', dropped))['map.md'];
    assert.equal(lineFor(text, '- q4'), '- q4 — split up');
  });

  it('does not link a dropped topic', () => {
    const text = index(topic('q4', '', { status: 'dropped' }))['map.md'];
    assert.equal(lineFor(text, '- [[q4]]'), '');
  });

  it('counts sources tied by frontmatter and by links', () => {
    const text = index(
      topic('checkout', '## Decisions\n\n- Ship. ([[ENG-2]])\n'),
      source('ENG-1', '', { topics: ['checkout'] }),
      source('ENG-2'),
    )['map.md'];
    assert.ok(lineFor(text, '- [[checkout]]').includes('2 sources'));
  });

  it('relates topics that share a source', () => {
    const text = index(
      topic('checkout'),
      topic('payments'),
      source('ENG-1', '', { topics: ['checkout', 'payments'] }),
    )['map.md'];
    const line = lineFor(text, '- [[checkout]]');
    assert.ok(line.includes('see also: [[payments]]'));
  });

  it('relates notes an agent session used together', () => {
    const used = '## Key points\n\n- used — [[checkout]], [[payments]] for X\n';
    const text = index(
      topic('checkout'),
      area('payments'),
      source('agent-2026-11-18-app', used, { source: 'agent' }),
    )['map.md'];
    const line = lineFor(text, '- [[payments]]');
    assert.ok(line.includes('see also: [[checkout]]'));
  });

  it('counts use by agent sessions', () => {
    const used = '## Key points\n\n- used — [[checkout]] for X\n';
    const text = index(
      topic('checkout'),
      source('agent-2026-11-18-app', used, { source: 'agent' }),
    )['map.md'];
    assert.ok(lineFor(text, '- [[checkout]]').includes('used 1'));
  });

  it('lists the topics that name an area', () => {
    const text = index(
      area('payments'),
      topic('checkout', '', { areas: ['payments'] }),
    )['map.md'];
    const line = lineFor(text, '- [[payments]]');
    assert.ok(line.includes('topics: [[checkout]]'));
  });

  it('counts notes under any of a person’s names', () => {
    const text = index(
      person('jane-doe', 'Jane Doe', { aliases: ['Jane'] }),
      source('ENG-1', '', { participants: ['Jane Doe'] }),
      source('ENG-2', '', { participants: ['jane'] }),
    )['map.md'];
    assert.ok(lineFor(text, '- [[jane-').includes('in 2 source notes'));
  });
});

const DECISIONS =
  '## Decisions\n\n' +
  '- 2026-10-28 — Web only. ([[ENG-1]])\n' +
  '- ~~2026-10-14 — Everywhere.~~ Superseded 2026-10-28.\n';

describe('live knowledge', () => {
  it('tags a live decision with its topic', () => {
    const text = index(topic('checkout', DECISIONS))['knowledge.md'];
    const expected = '- decision · [[checkout]] · 2026-10-28 — Web only.';
    assert.ok(text.includes(expected));
  });

  it('leaves out a superseded decision', () => {
    const text = index(topic('checkout', DECISIONS))['knowledge.md'];
    assert.ok(!text.includes('Everywhere'));
  });

  it('keeps an archived topic’s knowledge, marked archived', () => {
    const archived = topic('checkout', DECISIONS, { status: 'archived' });
    const text = index(archived)['knowledge.md'];
    assert.ok(text.includes('[[checkout]] (archived) · 2026-10-28'));
  });

  it('takes nothing from a dropped topic', () => {
    const dropped = topic('checkout', DECISIONS, { status: 'dropped' });
    assert.ok(!index(dropped)['knowledge.md'].includes('Web only'));
  });

  it('lists an area’s facts', () => {
    const facts = '## Facts\n\n- Retries failed charges. ([[ENG-1]])\n';
    const text = index(area('payments', facts))['knowledge.md'];
    assert.ok(text.includes('- fact · [[payments]] · Retries failed charges.'));
  });
});

describe('tickets', () => {
  it('gives a ticket note its title', () => {
    const tickets = index(source('ENG-1', '', { title: 'Fix cart total' }));
    const line = lineFor(tickets['tickets.md'], '- [[ENG-1]]');
    assert.ok(line.includes('Fix cart total'));
  });

  it('lists the notes that mention a ticket', () => {
    const tickets = index(
      source('ENG-1', '', { topics: ['checkout'] }),
      topic('checkout', '## Decisions\n\n- Ship ENG-1 first.\n'),
    );
    const line = lineFor(tickets['tickets.md'], '- [[ENG-1]]');
    assert.ok(line.includes('in: [[checkout]]'));
  });

  it('resolves a pull request reference to its note', () => {
    const tickets = index(
      source('app-12', '', { source: 'github' }),
      source('ENG-1', '## Summary\n\nFixed by app#12.\n'),
    );
    const line = lineFor(tickets['tickets.md'], '- [[app-12]]');
    assert.ok(line.includes('in: [[ENG-1]]'));
  });

  it('lists a ticket without a note once two notes mention it', () => {
    const tickets = index(
      source('ENG-1', '## Summary\n\nBlocked by OPS-9.\n'),
      source('ENG-2', '## Summary\n\nAlso waits on OPS-9.\n'),
    );
    assert.ok(lineFor(tickets['tickets.md'], '- OPS-9').includes('no note'));
  });

  it('leaves out a ticket without a note that one note mentions', () => {
    const tickets = index(source('ENG-1', '## Summary\n\nUses UTF-8.\n'));
    assert.ok(!tickets['tickets.md'].includes('UTF-8'));
  });

  it('orders tickets by number, not by text', () => {
    const lines = index(source('ENG-10'), source('ENG-9'))['tickets.md'];
    assert.ok(lines.indexOf('[[ENG-9]]') < lines.indexOf('[[ENG-10]]'));
  });
});

function lint(...notes: Note[]): string {
  return index(...notes)['lint.md'];
}

function repeat(make: (n: number) => Note): Note[] {
  return [0, 1, 2].map(make);
}

describe('lint', () => {
  it('finds nothing to tidy in a clean vault', () => {
    const clean = topic('checkout', '', { last_updated: '1', promoted: '1' });
    assert.ok(lint(clean).includes('Nothing to tidy'));
  });

  it('flags a topic that was never promoted', () => {
    const text = lint(topic('checkout', '', { last_updated: '2026-11-02' }));
    assert.ok(text.includes('## Needs promotion (1)'));
  });

  it('flags a topic that changed since its promotion', () => {
    const dates = { last_updated: '2026-11-05', promoted: '2026-11-02' };
    assert.ok(
      lint(topic('checkout', '', dates)).includes('## Needs promotion (1)'),
    );
  });

  it('promotes archived topics first', () => {
    const text = lint(topic('a'), topic('b', '', { status: 'archived' }));
    assert.ok(text.indexOf('- [[b]]') < text.indexOf('- [[a]]'));
  });

  it('flags a source note without a topic or an area', () => {
    assert.ok(lint(source('E-1')).includes('## Unfiled source notes (1)'));
  });

  it('never calls an agent note unfiled', () => {
    const agent = source('agent-2026-11-18-app', '', { source: 'agent' });
    assert.ok(!lint(agent).includes('Unfiled'));
  });

  it('flags frontmatter that names a dropped topic', () => {
    const text = lint(
      topic('q4', '', { status: 'dropped' }),
      source('ENG-1', '', { topics: ['q4'] }),
    );
    assert.ok(text.includes('[[ENG-1]] names topic `q4`'));
  });

  it('flags a link to a missing note', () => {
    const text = lint(source('ENG-1', '## Summary\n\nSee [[gone]].\n'));
    assert.ok(text.includes('- `gone` ← [[ENG-1]]'));
  });

  it('flags a note name used in two folders', () => {
    const text = lint(
      source('sync', '', { source: 'fellow' }),
      source('sync', '', { source: 'cal' }),
    );
    assert.ok(text.includes('## Duplicate note names (1)'));
  });

  it('flags a recurring name without a people note', () => {
    const notes = repeat((n) => source(`E-${n}`, '', { participants: ['Robin'] }));
    assert.ok(lint(...notes).includes('- Robin (3 source notes)'));
  });

  it('knows a name that matches a person’s alias', () => {
    const notes = repeat((n) => source(`E-${n}`, '', { participants: ['Robin'] }));
    const robin = person('robin-l', 'Robin Lee', { aliases: ['Robin'] });
    assert.ok(!lint(...notes, robin).includes('People without a note'));
  });

  it('flags a decision without a source link', () => {
    const uncited = topic('checkout', '## Decisions\n\n- Ship it.\n');
    assert.ok(lint(uncited).includes('## Bullets without a source (1)'));
  });

  it('flags a ticket in three notes that has no note of its own', () => {
    const notes = repeat((n) => source(`E-${n}`, '## Summary\n\nOPS-9.\n'));
    assert.ok(lint(...notes).includes('- OPS-9 (3 notes)'));
  });
});

const LONG_AGO = new Date('2020-01-01T00:00:00Z');
const INLINE_QUERY_TOPIC =
  '---\nstatus: active\ndescription: Shows `$= 1+1` inline\n---\n';

describe('rebuild', () => {
  it('writes every index file', (t) => {
    const vault = tempDir(t);
    writeFiles(vault, { 'topics/checkout.md': INLINE_QUERY_TOPIC });
    vaultIndex.rebuild(vault);
    const written = readdirSync(join(vault, 'index')).sort();
    const expected = ['knowledge.md', 'lint.md', 'map.md', 'tickets.md'];
    assert.deepEqual(written, expected);
  });

  it('disables inline queries copied from notes', (t) => {
    const vault = tempDir(t);
    writeFiles(vault, { 'topics/checkout.md': INLINE_QUERY_TOPIC });
    vaultIndex.rebuild(vault);
    const map = readFileSync(join(vault, 'index/map.md'), 'utf8');
    assert.ok(!map.includes('`$='));
  });

  it('leaves an index file alone when its text has not changed', (t) => {
    const vault = tempDir(t);
    writeFiles(vault, { 'topics/checkout.md': INLINE_QUERY_TOPIC });
    vaultIndex.rebuild(vault);
    const map = join(vault, 'index/map.md');
    utimesSync(map, LONG_AGO, LONG_AGO);
    vaultIndex.rebuild(vault);
    assert.equal(statSync(map).mtimeMs, LONG_AGO.getTime());
  });

  it('returns the number of lint entries', (t) => {
    const vault = tempDir(t);
    writeFiles(vault, { 'topics/checkout.md': INLINE_QUERY_TOPIC });
    assert.equal(vaultIndex.rebuild(vault), 1);
  });
});
