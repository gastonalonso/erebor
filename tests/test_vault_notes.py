import tempfile
import unittest
from pathlib import Path

import vault_notes

TOPIC = """---
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

- [ ] Gaston — draft the ticket, written as `[[not-a-link]]`
"""


def parse(text=TOPIC, path="topics/checkout.md"):
    return vault_notes.parse_note(path, text)


class FrontmatterTest(unittest.TestCase):
    def test_quoted_value_keeps_its_colon_and_inner_quotes(self):
        self.assertEqual(
            parse().meta["description"], 'Checkout "v2" redesign: Web'
        )

    def test_block_list_becomes_a_list(self):
        self.assertEqual(parse().meta["aliases"], ["Checkout v2", "Cart"])

    def test_inline_list_keeps_a_quoted_comma(self):
        self.assertEqual(
            parse().meta["areas"], ["order-history", "payments, web"]
        )

    def test_note_without_frontmatter_has_no_fields(self):
        self.assertEqual(parse("## Summary\n\nText.\n").meta, {})

    def test_empty_field_reads_as_an_empty_list(self):
        meta = parse("---\naliases:\nstatus: active\n---\n").meta
        self.assertEqual(vault_notes.as_list(meta["aliases"]), [])

    def test_scalar_field_reads_as_a_one_item_list(self):
        self.assertEqual(vault_notes.as_list("checkout"), ["checkout"])


class SectionsTest(unittest.TestCase):
    def test_continuation_lines_join_their_bullet(self):
        first = parse().sections["Decisions"][0]
        self.assertTrue(first.endswith("[[ENG-1234#Scope]])"))

    def test_each_bullet_is_one_entry(self):
        self.assertEqual(len(parse().sections["Decisions"]), 2)

    def test_text_outside_a_section_is_left_out(self):
        self.assertEqual(list(parse().sections), ["Decisions", "Action items"])


class LinksTest(unittest.TestCase):
    def test_link_alias_is_dropped(self):
        self.assertIn("2026-10-28-design-review", parse().links)

    def test_link_heading_is_dropped(self):
        self.assertIn("ENG-1234", parse().links)

    def test_link_in_inline_code_is_ignored(self):
        self.assertNotIn("not-a-link", parse().links)


class NoteTest(unittest.TestCase):
    def test_name_is_the_file_name_without_its_extension(self):
        self.assertEqual(parse().name, "checkout")

    def test_folder_is_the_top_level_folder(self):
        note = parse(path="sources/linear/ENG-1234.md")
        self.assertEqual(note.folder, "sources")


class LoadTest(unittest.TestCase):
    def test_load_reads_only_the_note_folders(self):
        vault = Path(tempfile.mkdtemp())
        for path in ("topics/a.md", "sources/linear/B-1.md", "index/map.md"):
            (vault / path).parent.mkdir(parents=True, exist_ok=True)
            (vault / path).write_text("## Summary\n")
        paths = [note.path for note in vault_notes.load(vault)]
        self.assertEqual(paths, ["topics/a.md", "sources/linear/B-1.md"])


if __name__ == "__main__":
    unittest.main()
