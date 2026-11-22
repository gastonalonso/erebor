/** Lists what in the vault needs tidying, for ingest runs and for me. */

import { casefold, compare, setDefault, shown } from './python.ts';
import { type Note, asList, printed } from './vault-notes.ts';
import type { Vault } from './vault.ts';

export const INTRO =
  'What needs tidying. The upkeep pass works through some of it after ' +
  'each run; the rest is for an interactive session.';
const CITED_SECTIONS = {
  Facts: 'fact',
  Decisions: 'decision',
  Constraints: 'constraint',
};
const SUPERSEDED = '~~';
const AGENT = 'agent';
const ARCHIVED = 'archived';
// How many notes a name or ticket shows up in before it earns its own note.
const RECURRING = 3;
const TEASER_LENGTH = 100;

function links(names: Iterable<string>): string {
  const sorted = [...names].sort(compare);
  return sorted.map((name) => `[[${name}]]`).join(', ');
}

function isStale(topic: Note): boolean {
  const promoted = topic.meta.get('promoted');
  if (!shown(promoted)) return true;
  return compare(printed(topic, 'last_updated', ''), shown(promoted)) > 0;
}

function archivedFirst(topic: Note): number {
  return topic.meta.get('status') === ARCHIVED ? 0 : 1;
}

/** Topics whose lasting knowledge isn't in the areas yet, archived first. */
export function needsPromotion(vault: Vault): Note[] {
  return vault.topics
    .filter(isStale)
    .sort(
      (one, other) =>
        archivedFirst(one) - archivedFirst(other) ||
        compare(one.name, other.name),
    );
}

function promotionLines(vault: Vault): string[] {
  return needsPromotion(vault).map(
    (topic) =>
      `- [[${topic.name}]] — ${printed(topic, 'status')} · updated ` +
      `${printed(topic, 'last_updated')} · promoted ` +
      (shown(topic.meta.get('promoted')) || 'never'),
  );
}

function isUnfiled(source: Note): boolean {
  const filed = [
    ...asList(source.meta.get('topics')),
    ...asList(source.meta.get('areas')),
  ];
  return filed.length === 0 && source.meta.get('source') !== AGENT;
}

function unfiled(vault: Vault): string[] {
  return vault.sources
    .filter(isUnfiled)
    .map(
      (source) => `- [[${source.name}]] — ${printed(source, 'title', '')}`,
    );
}

function missingSlugs(vault: Vault): string[] {
  const known = {
    topics: new Set(vault.topics.map((topic) => topic.name)),
    areas: new Set(vault.areas.map((area) => area.name)),
  };
  return [...vault.sources, ...vault.topics].flatMap((note) =>
    Object.entries(known).flatMap(([field, names]) => {
      const named = new Set(asList(note.meta.get(field)));
      const missing = [...named].filter((slug) => !names.has(slug));
      const kind = field.slice(0, -1);
      return missing
        .sort(compare)
        .map((slug) => `- [[${note.name}]] names ${kind} \`${slug}\``);
    }),
  );
}

function brokenLinks(vault: Vault): string[] {
  const linkedFrom = new Map<string, Set<string>>();
  for (const note of vault.notes) {
    const broken = [...note.links].filter((target) => !vault.named.has(target));
    for (const target of broken) {
      setDefault(linkedFrom, target, new Set()).add(note.name);
    }
  }
  return [...linkedFrom.keys()]
    .sort(compare)
    .map(
      (target) =>
        `- \`${target}\` ← ${links(linkedFrom.get(target) ?? [])}`,
    );
}

function duplicates(vault: Vault): string[] {
  return [...vault.named.entries()]
    .filter(([, notes]) => notes.length > 1)
    .sort(([one], [other]) => compare(one, other))
    .map(
      ([name, notes]) =>
        `- \`${name}\`: ${notes.map((note) => note.path).join(', ')}`,
    );
}

function byCountThenName(counts: Map<string, number>) {
  return (one: string, other: string) =>
    (counts.get(other) ?? 0) - (counts.get(one) ?? 0) || compare(one, other);
}

function unknownPeople(vault: Vault): string[] {
  const counts = new Map<string, number>();
  for (const source of vault.sources) {
    const names = new Set(asList(source.meta.get('participants')));
    const unknown = [...names].filter(
      (name) => !vault.personNamed.has(casefold(name)),
    );
    for (const name of unknown) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.keys()]
    .filter((name) => (counts.get(name) ?? 0) >= RECURRING)
    .sort(byCountThenName(counts))
    .map((name) => `- ${name} (${counts.get(name)} source notes)`);
}

function teaser(bullet: string): string {
  return Array.from(bullet).slice(0, TEASER_LENGTH).join('');
}

function uncited(vault: Vault): string[] {
  return vault.hubs.flatMap((hub) =>
    Object.entries(CITED_SECTIONS).flatMap(([heading, kind]) =>
      (hub.sections.get(heading) ?? [])
        .filter(
          (bullet) => !bullet.includes('[[') && !bullet.startsWith(SUPERSEDED),
        )
        .map((bullet) => `- [[${hub.name}]] · ${kind} · ${teaser(bullet)}`),
    ),
  );
}

function unnotedTickets(vault: Vault): string[] {
  const counts = new Map<string, number>();
  for (const [key, notes] of vault.mentions) {
    const isRecurring = !vault.tickets.has(key) && notes.size >= RECURRING;
    if (isRecurring) counts.set(key, notes.size);
  }
  return [...counts.keys()]
    .sort(byCountThenName(counts))
    .map((key) => `- ${vault.labels.get(key)} (${counts.get(key)} notes)`);
}

const CHECKS: [string, string, (vault: Vault) => string[]][] = [
  [
    'Needs promotion',
    "Topics whose lasting knowledge isn't in the areas yet.",
    promotionLines,
  ],
  [
    'Unfiled source notes',
    'No topic and no area, so only a search finds them.',
    unfiled,
  ],
  [
    'Frontmatter names a missing note',
    'A `topics:` or `areas:` entry with no note, or a dropped topic.',
    missingSlugs,
  ],
  ['Broken links', "Links to notes that don't exist.", brokenLinks],
  [
    'Duplicate note names',
    'A `[[link]]` to one of these could mean either note.',
    duplicates,
  ],
  [
    'People without a note',
    `Names in ${RECURRING}+ source notes that match no person or alias.`,
    unknownPeople,
  ],
  [
    'Bullets without a source',
    'Facts, decisions and constraints that cite no note.',
    uncited,
  ],
  [
    'Mentioned without a note',
    `Tickets and pull requests that ${RECURRING} or more notes mention.`,
    unnotedTickets,
  ],
];

/** The lint page's lines: one section per check that found something. */
export function render(vault: Vault): string[] {
  const lines = CHECKS.flatMap(([title, hint, check]) => {
    const found = check(vault);
    if (found.length === 0) return [];
    return [`## ${title} (${found.length})`, '', hint, '', ...found, ''];
  });
  return lines.length > 0 ? lines : ['Nothing to tidy.', ''];
}
