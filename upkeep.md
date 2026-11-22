# Vault upkeep @@RUN_ID@@

You are running unattended: nobody can answer questions, so make reasonable calls and record anything uncertain in the run log. Your working directory is the Obsidian vault at `@@VAULT@@`. Its `CLAUDE.md` (already loaded) defines every note format; follow it exactly. Today's local date is @@TODAY@@.

Create files with Write (it creates missing folders) and change them with Edit, one file at a time. There is no shell.

This pass fetches nothing. Its whole job is to keep what the vault already holds findable after the projects that produced it end. Start by reading `index/map.md`, which lists every area, topic and person, and `index/lint.md`, which lists what needs tidying. Both were just rebuilt.

## The job

1. **Promote.** Follow "Promoting to areas" in `CLAUDE.md` for each of these topics, in this order. Finish one, including its `promoted:` date, before you start the next:

@@TOPICS@@

   An archived topic is off my dashboard, not out of date: what it decided still holds. For a topic promoted before, only what changed since its `promoted:` date needs a look.
2. **Tidy.** Work through these sections of `index/lint.md`:
   - **Unfiled source notes.** For up to ten, read the note and add the area or topic it is about to its `areas:` or `topics:`. Create the area when "Area note format" allows it, and give it the facts the note supports. Leave a true one-off unfiled.
   - **People without a note.** For up to five, most frequent first, write the people note, or add the name to the `aliases` of the person it is another spelling of.
   - **Broken links.** Repoint each one whose target is clear.

   Leave the other sections; you can't rename or delete files.
3. **Log.** Add a `- Promoted:` line and a `- Tidied:` line to the `## Run @@RUN_ID@@` section of `runs/@@TODAY@@.md`, following the run-log format in `CLAUDE.md`. Create the file or the section if it isn't there.

## Rules

- **Never invent anything.** Every bullet you add to an area or people note must link to the source note that supports it. Read the source note when a topic's bullet is too thin to stand on its own.
- **Never write code into notes.** No `dataviewjs` blocks and no inline `$=` queries: Obsidian runs them as code.
- **Only touch your own files.** Write only under `areas/`, `people/`, `topics/` and `runs/`, and to the `topics:` and `areas:` lines of notes under `sources/`. Never modify `CLAUDE.md`, `dashboards/`, `index/`, `.obsidian/`, the inboxes, or anything else. The index is rebuilt from your notes after the pass.

End with a one-line summary as your final reply.
