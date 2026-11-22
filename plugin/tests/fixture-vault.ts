/** A vault full of the cases where Python and JavaScript read text apart. */

const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const NEXT_LINE = String.fromCodePoint(0x85);
const NO_BREAK_SPACE = String.fromCodePoint(0xa0);
const FILE_SEPARATOR = String.fromCodePoint(0x1c);
const UNIT_SEPARATOR = String.fromCodePoint(0x1f);
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);
const FULLWIDTH_A = String.fromCodePoint(0xff21);
const EMOJI = String.fromCodePoint(0x1f600);
const LONG_FACT = `Uncited ${EMOJI.repeat(60)} and then enough plain text to pass the teaser length.`;

function source(kind: string, fields: string, body = ''): string {
  return `---\nsource: ${kind}\n${fields}---\n\n${body}`;
}

export const FIXTURE_VAULT: Record<string, string> = {
  'areas/payments.md': `---
description: 'Retries "failed" charges: it''s true'
aliases: [Payments, "web, payments", 'single']
last_updated: 2026-11-10
---

Intro with [[loose-link]] before any heading.

## Facts

- Retries failed charges. ([[ENG-1]])
- ${LONG_FACT}
  and it continues on the next line
${NO_BREAK_SPACE}and on a line that starts with a no-break space
- ~~Old fact.~~ Superseded.
- Split by a line separator${LINE_SEPARATOR}- second half
- Ends with whitespace only Python strips${UNIT_SEPARATOR}
- ${BYTE_ORDER_MARK}Starts with whitespace only JavaScript strips

## Constraints  ${NEXT_LINE}

- Must keep OPS-7 behaviour, see app#12 and [[app-12]].
- Written as \`[[not-a-link]]\` and \`$= 1 + 1\`.

### A deeper heading is not a section

- Still a constraint bullet.
`,
  'areas/sub/nested-area.md': '## Facts\n\n- Nested areas count. ([[ENG-2]])\n',
  'areas/checkout.md':
    '---\ndescription: An area that shares its name with a topic\n---\n',
  'topics/checkout.md': `---
status: archived
description: "Checkout \\"v2\\": Desktop"
areas: [payments, missing-area]
last_updated: 2026-11-05
promoted: 2026-11-02
---

## Decisions

- 2026-10-28 — Web only. ([[ENG-1]])
- ~~2026-10-14 — Everywhere.~~ Superseded.
- Ship it without a source.

## Open questions

- Gaston — Does UTF-8 matter here?
`,
  'topics/alpha.md': `---
status: active
description: Fully promoted
aliases:
  - First
  - "Second, quoted"
last_updated: 2026-11-02
promoted: 2026-11-02
---

## Answered questions

- Yes. ([[ENG-10]])

## Gaps

- Nobody knows about [[gone]].
`,
  'topics/Zeta.md':
    '---\nstatus: proposed\ndescription: Uppercase sorts first\n---\n\n## Decisions\n\n- See [[alpha]] and ENG-9.\n',
  'topics/q4.md': '---\nstatus: dropped\ndescription: split up\n---\n',
  'topics/paused-one.md': '---\nstatus: paused\ndescription:\n---\n',
  'topics/weird.md': `---
status: [active]
description: [WIP] thing [2/2]
título: accented key
last_updated:
promoted: []
bad json: "not \\x valid"
---

---

## Facts

- After a horizontal rule. ([[ENG-1]])
`,
  'topics/nofence.md': '---\nstatus: active\n\n## Decisions\n\n- Never closed.\n',
  'topics/crlf.md':
    '---\r\nstatus: active\r\ndescription: Windows endings\r\n---\r\n\r\n## Decisions\r\n\r\n- Kept. ([[ENG-2]])\r\n',
  [`topics/topic-${EMOJI}.md`]: '---\nstatus: active\n---\n',
  [`topics/topic-${FULLWIDTH_A}.md`]: '---\nstatus: active\n---\n',
  'topics/bom.md': `${BYTE_ORDER_MARK}---\nstatus: active\n---\n`,
  'people/jane-doe.md':
    '---\nname: Jane Doe\naliases: [Jane, "Strauß"]\nrole: "Leads: desktop"\n---\n',
  'people/robin.md': '---\naliases:\n  - Robbie\n  - Yildiz\n---\n',
  'sources/linear/ENG-1.md': source(
    'linear',
    'source_id: "ENG-1"\ntitle: "Fix cart total"\ntopics: [checkout, q4]\nareas: [payments]\nparticipants: [Jane Doe, Robin L, robbie]\n',
    `## Summary

Blocked by ENG-2 and OPS-9. Fixed by app#12, not by ENG-5é or éENG-6.
Encoded as UTF-8. See [[gone]] and [[sub/path/ENG-2|the other one]].
Also example.components#7 and x_y#8, but not #9 alone.
`,
  ),
  'sources/linear/ENG-2.md': source(
    'linear',
    'source_id: "ENG-2-custom"\ntitle: Second\nparticipants: [Robin L, STRAUSS, Yıldız]\n',
    'Waits on OPS-9. See [[ENG-1#Heading]].\n',
  ),
  'sources/linear/ENG-10.md': source('linear', 'title: Ten\ntopics: alpha\n'),
  'sources/linear/ENG-9.md': source('linear', 'title: Nine\ntopics: [Zeta]\n'),
  'sources/linear/ENG-12-followup.md': source('linear', 'topics: [alpha]\n'),
  'sources/github/app-12.md': source(
    'github',
    'source_id: "example-org/app#12"\ntitle: [app] Fix crash [P1]\nareas: [payments]\nparticipants: [Robin L]\n',
    'Closes ENG-1.\n',
  ),
  'sources/fellow/2026-11-02-sync.md': source(
    'fellow',
    'title: Sync\ntopics: [checkout]\nparticipants:\n  - Jane\n  - Unknown Person\n',
    `## Action items\n\n- [ ] Gaston — follow up on OPS-9${FILE_SEPARATOR}\n`,
  ),
  'sources/fellow-x/2026-11-01-a.md': source('fellow', 'title: Sorts after\n'),
  'sources/fellow/sync.md': source('fellow', 'title: Duplicate name\n'),
  'sources/cal/sync.md': source('calendar', 'title: Duplicate name\n'),
  'sources/agent/agent-2026-11-18-app.md': source(
    'agent',
    'title: Session\n',
    '## Key points\n\n- used — [[checkout]], [[payments]] for X\n',
  ),
  'sources/slack/unfiled.md': source(
    'slack',
    'date: 2026-11-18\n',
    'Text.\n\n```dataviewjs\nalert(1)\n```\n\n  ~~~ dataviewjs\n~~~\n\n```dataviewjsé\n```\n',
  ),
  'sources/manual/api.md': source(
    'manual',
    'title: "ENG-77 came up"\ntopics: [missing-topic]\n',
    'A third note about OPS-9.\n',
  ),
};
