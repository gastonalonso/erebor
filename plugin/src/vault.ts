/** The notes of a vault, plus the lookups the index and lint share. */

import { BOUNDARY, WORD, casefold, setDefault } from './python.ts';
import { type Note, asList, printed } from './vault-notes.ts';

const DROPPED = 'dropped';
const TICKET_SOURCES = ['linear', 'github'];
// ASCII digits only: Python's `\d` also takes other scripts' digits, which no
// ticket ID uses.
const TICKET = new RegExp(
  `(?<![${WORD}-])[A-Z][A-Z0-9]*-[0-9]+${BOUNDARY}`,
  'gu',
);
const PULL_REQUEST = new RegExp(
  `${BOUNDARY}([A-Za-z][${WORD}.-]*)#([0-9]+)${BOUNDARY}`,
  'gu',
);

export class Vault {
  readonly notes: Note[];
  readonly named = new Map<string, Note[]>();
  readonly areas: Note[];
  readonly people: Note[];
  readonly sources: Note[];
  readonly dropped: Note[];
  readonly topics: Note[];
  readonly hubs: Note[];
  readonly evidence = new Map<string, Set<string>>();
  readonly personNamed = new Map<string, string>();
  readonly tickets = new Map<string, Note>();
  readonly mentions = new Map<string, Set<string>>();
  readonly labels = new Map<string, string>();

  constructor(notes: Note[]) {
    this.notes = notes;
    for (const note of notes) setDefault(this.named, note.name, []).push(note);
    this.areas = this.inFolder('areas');
    this.people = this.inFolder('people');
    this.sources = this.inFolder('sources');
    const topics = this.inFolder('topics');
    const isDropped = (topic: Note) => topic.meta.get('status') === DROPPED;
    this.dropped = topics.filter(isDropped);
    this.topics = topics.filter((topic) => !isDropped(topic));
    this.hubs = [...this.areas, ...this.topics];
    for (const hub of this.hubs) {
      this.evidence.set(hub.name, this.evidenceFor(hub));
    }
    this.namePeople();
    for (const source of this.sources) {
      const kind = source.meta.get('source');
      const isTicket =
        typeof kind === 'string' && TICKET_SOURCES.includes(kind);
      if (isTicket) this.tickets.set(source.name, source);
    }
    for (const note of notes) this.recordMentions(note);
  }

  peopleIn(source: Note): Set<string | undefined> {
    const names = asList(source.meta.get('participants'));
    return new Set(names.map((name) => this.personNamed.get(casefold(name))));
  }

  private inFolder(folder: string): Note[] {
    return this.notes.filter((note) => note.folder === folder);
  }

  /** Source notes tied to a hub by its links, theirs, or frontmatter. */
  private evidenceFor(hub: Note): Set<string> {
    const tied = this.sources.filter(
      (source) =>
        hub.links.has(source.name) ||
        source.links.has(hub.name) ||
        asList(source.meta.get(hub.folder)).includes(hub.name),
    );
    return new Set(tied.map((source) => source.name));
  }

  private namePeople(): void {
    for (const person of this.people) {
      const known = [
        ...asList(person.meta.get('name')),
        ...asList(person.meta.get('aliases')),
      ];
      for (const name of known) {
        this.personNamed.set(casefold(name), person.name);
      }
    }
  }

  /** Which notes mention each ticket, and how the ticket is written. */
  private recordMentions(note: Note): void {
    for (const [key, label] of this.references(note)) {
      setDefault(this.mentions, key, new Set()).add(note.name);
      setDefault(this.labels, key, label);
    }
  }

  private references(note: Note): Map<string, string> {
    const text = `${printed(note, 'title', '')}\n${note.body}`;
    const found = new Map<string, string>();
    for (const [key] of text.matchAll(TICKET)) found.set(key, key);
    for (const [, repo, number] of text.matchAll(PULL_REQUEST)) {
      found.set(`${repo}-${number}`, `${repo}#${number}`);
    }
    for (const name of note.links) {
      if (this.tickets.has(name)) found.set(name, name);
    }
    found.delete(note.name);
    return found;
  }
}
