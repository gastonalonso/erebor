import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as vaultNotes from '../src/vault-notes.ts';
import { tempDir, writeFiles } from './helpers.ts';

const TOPIC = `---
topic: checkout
status: archived
description: 'Checkout "v2" redesign: Web'
aliases:
  - Checkout v2
  - Cart
areas: [order-history, "payments, web"]
last_updated: 2026-11-02
---

Loose text before any heading, with [[a-loose-link]].

## Decisions

- 2026-10-28 — Guest checkout is web-only.
  ([[2026-10-28-design-review|the review]], [[ENG-1234#Scope]])
- ~~2026-10-14 — Ship everywhere.~~ Superseded.

## Action items

- [ ] Gaston — draft the ticket, written as \`[[not-a-link]]\`
`;

function parse(text = TOPIC, path = 'topics/checkout.md') {
  return vaultNotes.parseNote(path, text);
}

describe('frontmatter', () => {
  it('keeps the colon and inner quotes of a quoted value', () => {
    assert.equal(
      parse().meta.get('description'),
      'Checkout "v2" redesign: Web',
    );
  });

  it('reads a block list as a list', () => {
    assert.deepEqual(parse().meta.get('aliases'), ['Checkout v2', 'Cart']);
  });

  it('keeps a quoted comma in an inline list', () => {
    const areas = parse().meta.get('areas');
    assert.deepEqual(areas, ['order-history', 'payments, web']);
  });

  it('finds no fields in a note without frontmatter', () => {
    assert.equal(parse('## Summary\n\nText.\n').meta.size, 0);
  });

  it('reads an empty field as an empty list', () => {
    const { meta } = parse('---\naliases:\nstatus: active\n---\n');
    assert.deepEqual(vaultNotes.asList(meta.get('aliases')), []);
  });

  it('reads a scalar field as a one-item list', () => {
    assert.deepEqual(vaultNotes.asList('checkout'), ['checkout']);
  });
});

describe('sections', () => {
  it('joins continuation lines to their bullet', () => {
    const first = parse().sections.get('Decisions')?.[0] ?? '';
    assert.ok(first.endsWith('[[ENG-1234#Scope]])'));
  });

  it('keeps each bullet as one entry', () => {
    assert.equal(parse().sections.get('Decisions')?.length, 2);
  });

  it('leaves out text outside a section', () => {
    const headings = [...parse().sections.keys()];
    assert.deepEqual(headings, ['Decisions', 'Action items']);
  });
});

describe('links', () => {
  it('drops a link alias', () => {
    assert.ok(parse().links.has('2026-10-28-design-review'));
  });

  it('drops a link heading', () => {
    assert.ok(parse().links.has('ENG-1234'));
  });

  it('ignores a link in inline code', () => {
    assert.ok(!parse().links.has('not-a-link'));
  });
});

describe('a note', () => {
  it('is named after its file, without the extension', () => {
    assert.equal(parse().name, 'checkout');
  });

  it('belongs to its top-level folder', () => {
    const note = parse(TOPIC, 'sources/linear/ENG-1234.md');
    assert.equal(note.folder, 'sources');
  });
});

describe('load', () => {
  it('reads only the note folders', (t) => {
    const vault = tempDir(t);
    writeFiles(vault, {
      'topics/a.md': '## Summary\n',
      'sources/linear/B-1.md': '## Summary\n',
      'index/map.md': '## Summary\n',
    });
    const paths = vaultNotes.load(vault).map((note) => note.path);
    assert.deepEqual(paths, ['topics/a.md', 'sources/linear/B-1.md']);
  });
});
