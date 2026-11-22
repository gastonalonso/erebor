import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as python from '../src/python.ts';

const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const NEXT_LINE = String.fromCodePoint(0x85);
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);
const FULLWIDTH_A = String.fromCodePoint(0xff21);
const EMOJI = String.fromCodePoint(0x1f600);

describe('splitLines', () => {
  it('drops the empty line after a final newline', () => {
    assert.deepEqual(python.splitLines('a\nb\n'), ['a', 'b']);
  });

  it('keeps a blank line before the end', () => {
    assert.deepEqual(python.splitLines('a\n\n'), ['a', '']);
  });

  it('finds no lines in an empty text', () => {
    assert.deepEqual(python.splitLines(''), []);
  });

  it('breaks on a Unicode line separator', () => {
    assert.deepEqual(python.splitLines(`a${LINE_SEPARATOR}b`), ['a', 'b']);
  });
});

describe('strip', () => {
  it('removes a next-line character, which JavaScript keeps', () => {
    assert.equal(python.strip(`${NEXT_LINE} a ${NEXT_LINE}`), 'a');
  });

  it('keeps a byte order mark, which JavaScript removes', () => {
    assert.equal(python.strip(`${BYTE_ORDER_MARK}a`), `${BYTE_ORDER_MARK}a`);
  });
});

describe('compare', () => {
  it('puts uppercase before lowercase', () => {
    assert.ok(python.compare('Zeta', 'alpha') < 0);
  });

  it('puts a shorter prefix first', () => {
    assert.ok(python.compare('ENG-1', 'ENG-10') < 0);
  });

  it('puts an emoji after every character below it', () => {
    assert.ok(python.compare(FULLWIDTH_A, EMOJI) < 0);
  });
});

describe('comparePaths', () => {
  it('orders folder by folder, not character by character', () => {
    const order = python.comparePaths('fellow/b.md', 'fellow-x/a.md');
    assert.ok(order < 0);
  });
});

describe('casefold', () => {
  it('matches a sharp s with a double s', () => {
    assert.equal(python.casefold('Strauß'), python.casefold('STRAUSS'));
  });

  it('keeps a dotless i apart from a dotted one', () => {
    assert.notEqual(python.casefold('Yıldız'), python.casefold('Yildiz'));
  });
});

describe('str', () => {
  it('prints a string as it is', () => {
    assert.equal(python.str('Fix cart total'), 'Fix cart total');
  });

  it('prints a list as Python does', () => {
    assert.equal(python.str(['WIP', "it's"]), `['WIP', "it's"]`);
  });

  it('escapes a backslash inside a list item', () => {
    assert.equal(python.str(['a\\b']), "['a\\\\b']");
  });
});

describe('shown', () => {
  it('is empty for a missing value', () => {
    assert.equal(python.shown(undefined), '');
  });

  it('is empty for an empty list', () => {
    assert.equal(python.shown([]), '');
  });
});

describe('jsonDumps', () => {
  it('puts a space after each separator', () => {
    const options = { repos: ['a/b', 'c/d'], days: 14, on: true };
    assert.equal(
      python.jsonDumps(options),
      '{"repos": ["a/b", "c/d"], "days": 14, "on": true}',
    );
  });

  it('escapes characters outside ASCII', () => {
    assert.equal(python.jsonDumps('café'), '"caf\\u00e9"');
  });
});
