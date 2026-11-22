/**
 * Python's text behaviour, where JavaScript's differs, so that both engines
 * write the same bytes.
 */

import { readFileSync } from 'node:fs';

export type MetaValue = string | string[];

// What `\s`, `str.strip()` and `str.isspace()` count as whitespace, as the
// body of a character class.
export const SPACE =
  '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a' +
  '\\u2028\\u2029\\u202f\\u205f\\u3000';
// `\w` and `\b`, which in Python take the letters and digits of every script.
// Both need the `u` flag.
export const WORD = '\\p{L}\\p{N}_';
export const BOUNDARY =
  `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;

const EDGE_SPACE = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, 'g');
const LEADING_SPACE = new RegExp(`^[${SPACE}]`);
const LINE_BREAK = new RegExp(
  '\\r\\n|[\\n\\r\\v\\f\\x1c-\\x1e\\x85\\u2028\\u2029]',
);
const ANY_NEWLINE = /\r\n?/g;
const NOT_PRINTABLE_ASCII = new RegExp('[\\x7f-\\uffff]', 'g');
const UNPRINTABLE = /^(?:[\p{C}\p{Zl}\p{Zp}]|(?! )\p{Zs})$/u;
const SHORT_ESCAPES: Record<string, string> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};
const DOTLESS_I = 'ı';
const SURROGATES_START = 0xd800;
const SURROGATES_END = 0xe000;
const SURROGATES_SPAN = SURROGATES_END - SURROGATES_START;
const REST_OF_PLANE = 0x10000 - SURROGATES_END;
const HEX = 16;

export function strip(text: string): string {
  return text.replace(EDGE_SPACE, '');
}

export function startsWithSpace(text: string): boolean {
  return LEADING_SPACE.test(text);
}

export function splitLines(text: string): string[] {
  const lines = text.split(LINE_BREAK);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** A text file as `Path.read_text()` returns it: every line ends in `\n`. */
export function readText(path: string): string {
  return readFileSync(path, 'utf8').replace(ANY_NEWLINE, '\n');
}

// UTF-16 puts astral characters below U+E000; code points put them above.
function codePointRank(unit: number): number {
  if (unit < SURROGATES_START) return unit;
  return unit < SURROGATES_END ? unit + REST_OF_PLANE : unit - SURROGATES_SPAN;
}

/** Orders strings as Python does, by code point. */
export function compare(one: string, other: string): number {
  const shared = Math.min(one.length, other.length);
  for (let i = 0; i < shared; i++) {
    const left = one.charCodeAt(i);
    const right = other.charCodeAt(i);
    if (left !== right) return codePointRank(left) - codePointRank(right);
  }
  return one.length - other.length;
}

/** Orders vault paths as Python orders `Path` objects: folder by folder. */
export function comparePaths(one: string, other: string): number {
  const left = one.split('/');
  const right = other.split('/');
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    const order = compare(left[i], right[i]);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

// Lowercasing alone keeps "ß" apart from "SS"; the round trip matches them,
// as casefold does.
function foldCharacter(character: string): string {
  if (character === DOTLESS_I) return character;
  return character.toLowerCase().toUpperCase().toLowerCase();
}

/** Matches the same names as `str.casefold()`. */
export function casefold(text: string): string {
  return Array.from(text, foldCharacter).join('');
}

function hex(code: number, width: number): string {
  return code.toString(HEX).padStart(width, '0');
}

function escapeCharacter(character: string, quote: string): string {
  if (character === quote || character === '\\') return `\\${character}`;
  if (character in SHORT_ESCAPES) return SHORT_ESCAPES[character];
  if (!UNPRINTABLE.test(character)) return character;
  const code = character.codePointAt(0) ?? 0;
  if (code <= 0xff) return `\\x${hex(code, 2)}`;
  if (code <= 0xffff) return `\\u${hex(code, 4)}`;
  return `\\U${hex(code, 8)}`;
}

function repr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  const body = Array.from(text, (character) =>
    escapeCharacter(character, quote),
  );
  return quote + body.join('') + quote;
}

/** A frontmatter value as an f-string prints it: a list as its repr. */
export function str(value: MetaValue): string {
  return Array.isArray(value) ? `[${value.map(repr).join(', ')}]` : value;
}

/** A frontmatter value as printed, or "" when Python finds it falsy. */
export function shown(value: MetaValue | undefined): string {
  return value === undefined || value.length === 0 ? '' : str(value);
}

function escapeUnit(unit: string): string {
  return `\\u${hex(unit.charCodeAt(0), 4)}`;
}

/** `json.dumps(value)`: spaced separators and ASCII-only output. */
export function jsonDumps(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jsonDumps).join(', ')}]`;
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value).replace(NOT_PRINTABLE_ASCII, escapeUnit);
  }
  const fields = Object.entries(value).map(
    ([key, item]) => `${jsonDumps(key)}: ${jsonDumps(item)}`,
  );
  return `{${fields.join(', ')}}`;
}

export function setDefault<Key, Value>(
  map: Map<Key, Value>,
  key: Key,
  initial: Value,
): Value {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  map.set(key, initial);
  return initial;
}
