/** Reads vault notes: frontmatter, sections, bullets and links. */

import { type Dirent, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  type MetaValue,
  SPACE,
  WORD,
  comparePaths,
  readText,
  setDefault,
  splitLines,
  startsWithSpace,
  str,
  strip,
} from './python.ts';

export const NOTE_FOLDERS = ['areas', 'topics', 'people', 'sources'];
const NOTE_SUFFIX = '.md';
const FENCE = '---\n';
const CLOSING_FENCE = `\n${FENCE}`;
const QUOTES = '"\'';
const FIELD = new RegExp(`^([A-Za-z_][${WORD}-]*):[${SPACE}]*(.*)$`, 'u');
const LIST_ITEM = new RegExp(`^[${SPACE}]*-[${SPACE}]+(.*)$`);
const INLINE_ITEM = new RegExp(`"[^"]*"|'[^']*'|[^,${SPACE}][^,]*`, 'g');
const HEADING = new RegExp(`^## +(.+?)[${SPACE}]*$`);
const LINK = /\[\[([^\]|#]+)/g;
const INLINE_CODE = /`[^`\n]*`/g;

export type Meta = Map<string, MetaValue>;

export interface Note {
  path: string; // relative to the vault, such as "topics/checkout.md"
  name: string;
  folder: string;
  meta: Meta;
  body: string;
  // "## heading" text -> its bullets, one line each
  sections: Map<string, string[]>;
  links: Set<string>; // names of the notes the body links to
}

/** A frontmatter value as a list; an empty value is an empty list. */
export function asList(value: MetaValue | undefined): string[] {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

/** `meta.get(key, fallback)` as an f-string prints it. */
export function printed(note: Note, key: string, fallback = 'None'): string {
  const value = note.meta.get(key);
  return value === undefined ? fallback : str(value);
}

function scalar(raw: string): string {
  const text = strip(raw);
  const quote = text[0];
  const isQuoted =
    text.length >= 2 && quote === text.at(-1) && QUOTES.includes(quote);
  if (!isQuoted) return text;
  if (quote === "'") return text.slice(1, -1).replaceAll("''", "'");
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(1, -1);
  }
}

function parseValue(raw: string): MetaValue {
  const text = strip(raw);
  if (!text.startsWith('[') || !text.endsWith(']')) return scalar(text);
  return (text.slice(1, -1).match(INLINE_ITEM) ?? []).map(scalar);
}

/** Split a note into its frontmatter fields and its body. */
export function parseFrontmatter(text: string): { meta: Meta; body: string } {
  const end = text.startsWith(FENCE)
    ? text.indexOf(CLOSING_FENCE, FENCE.length)
    : -1;
  const meta: Meta = new Map();
  if (end < 0) return { meta, body: text };
  let key: string | undefined;
  for (const line of splitLines(text.slice(FENCE.length, end))) {
    const field = FIELD.exec(line);
    const item = LIST_ITEM.exec(line);
    if (field) {
      key = field[1];
      meta.set(key, parseValue(field[2]));
    } else if (item && key !== undefined) {
      meta.set(key, [...asList(meta.get(key)), scalar(item[1])]);
    }
  }
  return { meta, body: text.slice(end + CLOSING_FENCE.length) };
}

/** Map each `## heading` to its top-level bullets, one line each. */
export function parseSections(body: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let bullets: string[] | undefined;
  for (const line of splitLines(body)) {
    const heading = HEADING.exec(line);
    if (heading) {
      bullets = setDefault(sections, heading[1], []);
    } else if (bullets === undefined) {
      continue;
    } else if (line.startsWith('- ')) {
      bullets.push(strip(line.slice(2)));
    } else if (bullets.length > 0 && startsWithSpace(line) && strip(line)) {
      bullets[bullets.length - 1] += ` ${strip(line)}`;
    }
  }
  return sections;
}

export function findLinks(text: string): Set<string> {
  const targets = text.replace(INLINE_CODE, '').matchAll(LINK);
  const names = Array.from(
    targets,
    (match) => strip(match[1]).split('/').at(-1) ?? '',
  );
  return new Set(names);
}

function stem(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

export function parseNote(path: string, text: string): Note {
  const { meta, body } = parseFrontmatter(text);
  const parts = path.split('/');
  return {
    path,
    name: stem(parts.at(-1) ?? ''),
    folder: parts[0],
    meta,
    body,
    sections: parseSections(body),
    links: findLinks(body),
  };
}

function entriesOf(folder: string): Dirent[] {
  return existsSync(folder) ? readdirSync(folder, { withFileTypes: true }) : [];
}

/** Every note file under a vault folder, as paths relative to the vault. */
export function markdownFiles(
  vault: string,
  folder = '',
  skipped: readonly string[] = [],
): string[] {
  return entriesOf(join(vault, folder)).flatMap((entry) => {
    const path = folder ? `${folder}/${entry.name}` : entry.name;
    if (skipped.includes(entry.name)) return [];
    if (entry.isDirectory()) return markdownFiles(vault, path);
    return entry.name.endsWith(NOTE_SUFFIX) ? [path] : [];
  });
}

/** Every note in the vault's note folders. */
export function load(vault: string): Note[] {
  return NOTE_FOLDERS.flatMap((folder) =>
    markdownFiles(vault, folder)
      .sort(comparePaths)
      .map((path) => parseNote(path, readText(join(vault, path)))),
  );
}
