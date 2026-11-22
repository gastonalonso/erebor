## Inbox

Typed in [[inbox]], waiting for the next ingest run to file them.

```dataview
TASK
WHERE file.name = "inbox"
```

## Topics

Approve and Archive change the topic's `status` right away. To undo, edit
`status` in the note. Archiving a topic hides it, its action items and its
questions from this page only: it stays in the index, and Claude sessions keep
using what it decided.
Needs "Enable JavaScript queries" in the Dataview settings.

```dataviewjs
const topics = dv.pages('"topics"');
const evidence = slug =>
  dv.pages('"sources"').where(s => [].concat(s.topics ?? []).includes(slug)).length;

function statusButton(label, page, status) {
  const button = createEl("button", { text: label });
  button.onclick = () =>
    app.fileManager.processFrontMatter(
      app.vault.getAbstractFileByPath(page.file.path),
      frontmatter => { frontmatter.status = status; }
    );
  return button;
}

dv.header(3, "Active");
dv.table(
  ["Topic", "About", "Updated", ""],
  topics
    .where(p => p.status === "active" || p.status === "paused")
    .sort(p => p.last_updated, "desc")
    .map(p => [p.file.link, p.description ?? "", p.last_updated,
      statusButton("Archive", p, "archived")])
);

dv.header(3, "Proposed");
dv.table(
  ["Topic", "About", "Sources", "Updated", ""],
  topics
    .where(p => p.status === "proposed")
    .sort(p => p.last_updated, "desc")
    .map(p => [p.file.link, p.description ?? "", evidence(p.file.name),
      p.last_updated, statusButton("Approve", p, "active")])
);
```

## Action items

Mine only. Tick these off here or in the topic note; other people's items stay
in the notes for context.

```dataview
TASK
FROM "topics"
WHERE !completed AND meta(section).subpath = "Action items"
  AND startswith(text, "Gaston —")
  AND file.frontmatter.status != "archived"
GROUP BY file.link
```

## Waiting on others

Open items owned by someone else, from topics and from Slack notes that aren't
filed under any topic. They get ticked when a later source shows they're done.

```dataview
TASK
FROM "topics" OR "sources/slack"
WHERE !completed AND meta(section).subpath = "Action items"
  AND !startswith(text, "Gaston —")
  AND (startswith(file.folder, "topics") OR !topics OR length(topics) = 0)
  AND file.frontmatter.status != "archived"
GROUP BY file.link
```

## Open questions

Mine only. To sort them quickly, ask Claude in the vault: "triage open
questions". To dig into them: "let's go through the open questions".

```dataview
TABLE WITHOUT ID Q.text AS "Question", file.link AS "Topic"
FROM "topics"
FLATTEN file.lists AS Q
WHERE meta(Q.section).subpath = "Open questions" AND !Q.task
  AND startswith(Q.text, "Gaston —") AND status != "archived"
SORT file.link ASC
```

## Watching

Open questions for someone else to answer.

```dataview
TABLE WITHOUT ID Q.text AS "Question", file.link AS "Topic"
FROM "topics"
FLATTEN file.lists AS Q
WHERE meta(Q.section).subpath = "Open questions" AND !Q.task
  AND !startswith(Q.text, "Gaston —") AND status != "archived"
SORT file.link ASC
```
