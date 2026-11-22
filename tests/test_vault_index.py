import json
import tempfile
import unittest
from pathlib import Path

import vault_index
import vault_notes


def note(path, body="", **meta):
    fields = "".join(f"{key}: {json.dumps(meta[key])}\n" for key in meta)
    return vault_notes.parse_note(path, f"---\n{fields}---\n{body}")


def source(name, body="", folder="linear", **meta):
    meta = {"source": folder, "title": name, **meta}
    return note(f"sources/{folder}/{name}.md", body, **meta)


def topic(name, body="", **meta):
    meta = {"status": "active", "description": f"About {name}", **meta}
    return note(f"topics/{name}.md", body, **meta)


def area(name, body="", **meta):
    meta = {"description": f"About {name}", **meta}
    return note(f"areas/{name}.md", body, **meta)


def person(slug, name, **meta):
    return note(f"people/{slug}.md", name=name, **meta)


def index(*notes):
    return vault_index.build(list(notes))


def line_for(text, start):
    matches = [line for line in text.splitlines() if line.startswith(start)]
    return matches[0] if matches else None


class MapTest(unittest.TestCase):
    def test_topic_line_carries_its_description(self):
        text = index(topic("checkout"))["map.md"]
        self.assertIn("About checkout", line_for(text, "- [[checkout]]"))

    def test_topic_line_carries_its_aliases(self):
        text = index(topic("checkout", aliases=["Cart"]))["map.md"]
        self.assertIn("also: Cart", line_for(text, "- [[checkout]]"))

    def test_archived_topic_stays_on_the_map_with_its_status(self):
        text = index(topic("checkout", status="archived"))["map.md"]
        self.assertIn("— archived —", line_for(text, "- [[checkout]]"))

    def test_dropped_topic_is_listed_with_its_reason_only(self):
        dropped = topic("q4", status="dropped", description="split up")
        text = index(dropped)["map.md"]
        self.assertEqual(line_for(text, "- q4"), "- q4 — split up")
        self.assertIsNone(line_for(text, "- [[q4]]"))

    def test_sources_count_frontmatter_and_links(self):
        notes = [
            topic("checkout", "## Decisions\n\n- Ship. ([[ENG-2]])\n"),
            source("ENG-1", topics=["checkout"]),
            source("ENG-2"),
        ]
        text = index(*notes)["map.md"]
        self.assertIn("2 sources", line_for(text, "- [[checkout]]"))

    def test_topics_sharing_a_source_see_each_other(self):
        notes = [
            topic("checkout"),
            topic("payments"),
            source("ENG-1", topics=["checkout", "payments"]),
        ]
        text = index(*notes)["map.md"]
        self.assertIn("see also: [[payments]]", line_for(text, "- [[checkout]]"))

    def test_notes_an_agent_session_used_together_see_each_other(self):
        used = "## Key points\n\n- used — [[checkout]], [[payments]] for X\n"
        notes = [
            topic("checkout"),
            area("payments"),
            source("agent-2026-11-18-app", used, folder="agent"),
        ]
        text = index(*notes)["map.md"]
        self.assertIn("see also: [[checkout]]", line_for(text, "- [[payments]]"))

    def test_use_by_agent_sessions_is_counted(self):
        used = "## Key points\n\n- used — [[checkout]] for X\n"
        notes = [
            topic("checkout"),
            source("agent-2026-11-18-app", used, folder="agent"),
        ]
        text = index(*notes)["map.md"]
        self.assertIn("used 1", line_for(text, "- [[checkout]]"))

    def test_area_lists_the_topics_that_name_it(self):
        notes = [area("payments"), topic("checkout", areas=["payments"])]
        text = index(*notes)["map.md"]
        self.assertIn("topics: [[checkout]]", line_for(text, "- [[payments]]"))

    def test_person_counts_notes_under_any_of_their_names(self):
        notes = [
            person("jane-doe", "Jane Doe", aliases=["Jane"]),
            source("ENG-1", participants=["Jane Doe"]),
            source("ENG-2", participants=["jane"]),
        ]
        text = index(*notes)["map.md"]
        self.assertIn("in 2 source notes", line_for(text, "- [[jane-"))


class KnowledgeTest(unittest.TestCase):
    DECISIONS = (
        "## Decisions\n\n"
        "- 2026-10-28 — Web only. ([[ENG-1]])\n"
        "- ~~2026-10-14 — Everywhere.~~ Superseded 2026-10-28.\n"
    )

    def test_live_decision_is_tagged_with_its_topic(self):
        text = index(topic("checkout", self.DECISIONS))["knowledge.md"]
        self.assertIn(
            "- decision · [[checkout]] · 2026-10-28 — Web only.", text
        )

    def test_superseded_decision_is_left_out(self):
        text = index(topic("checkout", self.DECISIONS))["knowledge.md"]
        self.assertNotIn("Everywhere", text)

    def test_archived_topic_keeps_its_knowledge_marked_archived(self):
        archived = topic("checkout", self.DECISIONS, status="archived")
        text = index(archived)["knowledge.md"]
        self.assertIn("[[checkout]] (archived) · 2026-10-28", text)

    def test_dropped_topic_contributes_nothing(self):
        dropped = topic("checkout", self.DECISIONS, status="dropped")
        self.assertNotIn("Web only", index(dropped)["knowledge.md"])

    def test_area_fact_is_listed(self):
        facts = "## Facts\n\n- Retries failed charges. ([[ENG-1]])\n"
        text = index(area("payments", facts))["knowledge.md"]
        self.assertIn("- fact · [[payments]] · Retries failed charges.", text)


class TicketsTest(unittest.TestCase):
    def test_ticket_note_lists_the_notes_that_mention_it(self):
        notes = [
            source("ENG-1", title="Fix cart total", topics=["checkout"]),
            topic("checkout", "## Decisions\n\n- Ship ENG-1 first.\n"),
        ]
        line = line_for(index(*notes)["tickets.md"], "- [[ENG-1]]")
        self.assertIn("Fix cart total", line)
        self.assertIn("in: [[checkout]]", line)

    def test_pull_request_reference_resolves_to_its_note(self):
        notes = [
            source("app-12", folder="github"),
            source("ENG-1", "## Summary\n\nFixed by app#12.\n"),
        ]
        line = line_for(index(*notes)["tickets.md"], "- [[app-12]]")
        self.assertIn("in: [[ENG-1]]", line)

    def test_ticket_without_a_note_is_listed_once_two_notes_mention_it(self):
        notes = [
            source("ENG-1", "## Summary\n\nBlocked by OPS-9.\n"),
            source("ENG-2", "## Summary\n\nAlso waits on OPS-9.\n"),
        ]
        line = line_for(index(*notes)["tickets.md"], "- OPS-9")
        self.assertIn("no note", line)

    def test_ticket_mentioned_once_without_a_note_is_left_out(self):
        notes = [source("ENG-1", "## Summary\n\nUses UTF-8.\n")]
        self.assertNotIn("UTF-8", index(*notes)["tickets.md"])


class LintTest(unittest.TestCase):
    def lint(self, *notes):
        return index(*notes)["lint.md"]

    def test_clean_vault_has_nothing_to_tidy(self):
        notes = [topic("checkout", last_updated="1", promoted="1")]
        self.assertIn("Nothing to tidy", self.lint(*notes))

    def test_topic_never_promoted_needs_promotion(self):
        text = self.lint(topic("checkout", last_updated="2026-11-02"))
        self.assertIn("## Needs promotion (1)", text)

    def test_topic_changed_since_promotion_needs_promotion(self):
        changed = topic(
            "checkout", last_updated="2026-11-05", promoted="2026-11-02"
        )
        self.assertIn("## Needs promotion (1)", self.lint(changed))

    def test_archived_topics_are_promoted_first(self):
        notes = [topic("a"), topic("b", status="archived")]
        lines = self.lint(*notes).splitlines()
        self.assertLess(
            lines.index(line_for(self.lint(*notes), "- [[b]]")),
            lines.index(line_for(self.lint(*notes), "- [[a]]")),
        )

    def test_source_note_without_topic_or_area_is_unfiled(self):
        self.assertIn("## Unfiled source notes (1)", self.lint(source("E-1")))

    def test_agent_note_is_never_unfiled(self):
        agent = source("agent-2026-11-18-app", folder="agent")
        self.assertNotIn("Unfiled", self.lint(agent))

    def test_frontmatter_naming_a_dropped_topic_is_flagged(self):
        notes = [
            topic("q4", status="dropped"),
            source("ENG-1", topics=["q4"]),
        ]
        self.assertIn("[[ENG-1]] names topic `q4`", self.lint(*notes))

    def test_link_to_a_missing_note_is_broken(self):
        text = self.lint(source("ENG-1", "## Summary\n\nSee [[gone]].\n"))
        self.assertIn("- `gone` ← [[ENG-1]]", text)

    def test_note_name_used_in_two_folders_is_a_duplicate(self):
        notes = [source("sync", folder="fellow"), source("sync", folder="cal")]
        self.assertIn("## Duplicate note names (1)", self.lint(*notes))

    def test_recurring_name_without_a_people_note_is_flagged(self):
        notes = [source(f"E-{n}", participants=["Robin"]) for n in range(3)]
        self.assertIn("- Robin (3 source notes)", self.lint(*notes))

    def test_name_matching_a_person_alias_is_known(self):
        notes = [source(f"E-{n}", participants=["Robin"]) for n in range(3)]
        notes.append(person("robin-l", "Robin Lee", aliases=["Robin"]))
        self.assertNotIn("People without a note", self.lint(*notes))

    def test_decision_without_a_source_link_is_flagged(self):
        uncited = topic("checkout", "## Decisions\n\n- Ship it.\n")
        self.assertIn("## Bullets without a source (1)", self.lint(uncited))

    def test_ticket_in_three_notes_without_its_own_is_flagged(self):
        notes = [source(f"E-{n}", "## Summary\n\nOPS-9.\n") for n in range(3)]
        self.assertIn("- OPS-9 (3 notes)", self.lint(*notes))


class RebuildTest(unittest.TestCase):
    def setUp(self):
        self.vault = Path(tempfile.mkdtemp())
        (self.vault / "topics").mkdir()
        (self.vault / "topics/checkout.md").write_text(
            "---\nstatus: active\ndescription: Shows `$= 1+1` inline\n---\n"
        )

    def test_rebuild_writes_every_index_file(self):
        vault_index.rebuild(self.vault)
        written = sorted(p.name for p in (self.vault / "index").iterdir())
        self.assertEqual(
            written, ["knowledge.md", "lint.md", "map.md", "tickets.md"]
        )

    def test_rebuild_disables_inline_queries_copied_from_notes(self):
        vault_index.rebuild(self.vault)
        self.assertNotIn("`$=", (self.vault / "index/map.md").read_text())

    def test_rebuild_returns_the_number_of_lint_entries(self):
        self.assertEqual(vault_index.rebuild(self.vault), 1)


if __name__ == "__main__":
    unittest.main()
