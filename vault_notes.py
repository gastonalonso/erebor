"""Reads vault notes: frontmatter, sections, bullets and links."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

NOTE_FOLDERS = ("areas", "topics", "people", "sources")
FENCE = "---\n"
FIELD = re.compile(r"^([A-Za-z_][\w-]*):\s*(.*)$")
LIST_ITEM = re.compile(r"^\s*-\s+(.*)$")
INLINE_ITEM = re.compile(r""""[^"]*"|'[^']*'|[^,\s][^,]*""")
HEADING = re.compile(r"^## +(.+?)\s*$")
LINK = re.compile(r"\[\[([^\]|#]+)")
INLINE_CODE = re.compile(r"`[^`\n]*`")


@dataclass(frozen=True)
class Note:
    path: str  # relative to the vault, such as "topics/checkout.md"
    meta: dict
    body: str
    sections: dict  # "## heading" text -> its bullets, one line each
    links: frozenset  # names of the notes the body links to

    @property
    def name(self) -> str:
        return Path(self.path).stem

    @property
    def folder(self) -> str:
        return self.path.split("/")[0]


def as_list(value) -> list:
    """A frontmatter value as a list; an empty value is an empty list."""
    if isinstance(value, list):
        return [item for item in value if item]
    return [value] if value else []


def _scalar(text: str) -> str:
    text = text.strip()
    if len(text) < 2 or text[0] != text[-1] or text[0] not in "\"'":
        return text
    if text[0] == "'":
        return text[1:-1].replace("''", "'")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text[1:-1]


def _value(text: str):
    text = text.strip()
    if text.startswith("[") and text.endswith("]"):
        return [_scalar(item) for item in INLINE_ITEM.findall(text[1:-1])]
    return _scalar(text)


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Split a note into its frontmatter fields and its body."""
    head, fence, body = text.removeprefix(FENCE).partition("\n" + FENCE)
    if not text.startswith(FENCE) or not fence:
        return {}, text
    meta, key = {}, None
    for line in head.splitlines():
        field, item = FIELD.match(line), LIST_ITEM.match(line)
        if field:
            key, meta[key] = field[1], _value(field[2])
        elif item and key:
            meta[key] = [*as_list(meta[key]), _scalar(item[1])]
    return meta, body


def parse_sections(body: str) -> dict:
    """Map each `## heading` to its top-level bullets, one line each."""
    sections, bullets = {}, None
    for line in body.splitlines():
        heading = HEADING.match(line)
        if heading:
            bullets = sections.setdefault(heading[1], [])
        elif bullets is None:
            continue
        elif line.startswith("- "):
            bullets.append(line[2:].strip())
        elif bullets and line[:1].isspace() and line.strip():
            bullets[-1] += " " + line.strip()
    return sections


def find_links(text: str) -> frozenset:
    names = LINK.findall(INLINE_CODE.sub("", text))
    return frozenset(name.strip().split("/")[-1] for name in names)


def parse_note(path: str, text: str) -> Note:
    meta, body = parse_frontmatter(text)
    return Note(
        path=path,
        meta=meta,
        body=body,
        sections=parse_sections(body),
        links=find_links(body),
    )


def load(vault: Path) -> list[Note]:
    """Every note in the vault's note folders."""
    notes = []
    for folder in NOTE_FOLDERS:
        for file in sorted((vault / folder).rglob("*.md")):
            path = file.relative_to(vault).as_posix()
            notes.append(parse_note(path, file.read_text()))
    return notes
