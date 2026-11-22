"""Lists what in the vault needs tidying, for ingest runs and for me."""

from __future__ import annotations

from collections import Counter, defaultdict

from vault_notes import as_list

INTRO = (
    "What needs tidying. The upkeep pass works through some of it after "
    "each run; the rest is for an interactive session."
)
CITED_SECTIONS = {
    "Facts": "fact",
    "Decisions": "decision",
    "Constraints": "constraint",
}
SUPERSEDED = "~~"
AGENT = "agent"
ARCHIVED = "archived"
# How many notes a name or ticket shows up in before it earns its own note.
RECURRING = 3
TEASER_LENGTH = 100


def _links(names) -> str:
    return ", ".join(f"[[{name}]]" for name in sorted(names))


def needs_promotion(vault) -> list:
    """Topics whose lasting knowledge isn't in the areas yet, archived first."""
    stale = [
        topic
        for topic in vault.topics
        if not topic.meta.get("promoted")
        or str(topic.meta.get("last_updated", "")) > str(topic.meta["promoted"])
    ]
    return sorted(
        stale, key=lambda t: (t.meta.get("status") != ARCHIVED, t.name)
    )


def _needs_promotion(vault) -> list:
    return [
        f"- [[{topic.name}]] — {topic.meta.get('status')} · updated "
        f"{topic.meta.get('last_updated')} · promoted "
        f"{topic.meta.get('promoted') or 'never'}"
        for topic in needs_promotion(vault)
    ]


def _is_unfiled(source) -> bool:
    filed = as_list(source.meta.get("topics")) + as_list(
        source.meta.get("areas")
    )
    return not filed and source.meta.get("source") != AGENT


def _unfiled(vault) -> list:
    return [
        f"- [[{source.name}]] — {source.meta.get('title', '')}"
        for source in vault.sources
        if _is_unfiled(source)
    ]


def _missing_slugs(vault) -> list:
    known = {
        "topics": {topic.name for topic in vault.topics},
        "areas": {area.name for area in vault.areas},
    }
    lines = []
    for note in vault.sources + vault.topics:
        for field, names in known.items():
            missing = set(as_list(note.meta.get(field))) - names
            kind = field.removesuffix("s")
            lines += [
                f"- [[{note.name}]] names {kind} `{slug}`"
                for slug in sorted(missing)
            ]
    return lines


def _broken_links(vault) -> list:
    linked_from = defaultdict(set)
    for note in vault.notes:
        for target in note.links - set(vault.named):
            linked_from[target].add(note.name)
    return [
        f"- `{target}` ← {_links(linked_from[target])}"
        for target in sorted(linked_from)
    ]


def _duplicates(vault) -> list:
    return [
        f"- `{name}`: {', '.join(note.path for note in notes)}"
        for name, notes in sorted(vault.named.items())
        if len(notes) > 1
    ]


def _unknown_people(vault) -> list:
    counts = Counter()
    for source in vault.sources:
        names = {str(name) for name in as_list(source.meta.get("participants"))}
        counts.update(
            name for name in names if name.casefold() not in vault.person_named
        )
    recurring = [name for name in counts if counts[name] >= RECURRING]
    recurring.sort(key=lambda name: (-counts[name], name))
    return [f"- {name} ({counts[name]} source notes)" for name in recurring]


def _uncited(vault) -> list:
    lines = []
    for hub in vault.hubs:
        for heading, kind in CITED_SECTIONS.items():
            lines += [
                f"- [[{hub.name}]] · {kind} · {bullet[:TEASER_LENGTH]}"
                for bullet in hub.sections.get(heading, [])
                if "[[" not in bullet and bullet[:2] != SUPERSEDED
            ]
    return lines


def _unnoted_tickets(vault) -> list:
    counts = {
        key: len(notes)
        for key, notes in vault.mentions.items()
        if key not in vault.tickets and len(notes) >= RECURRING
    }
    ordered = sorted(counts, key=lambda key: (-counts[key], key))
    return [f"- {vault.labels[key]} ({counts[key]} notes)" for key in ordered]


CHECKS = (
    (
        "Needs promotion",
        "Topics whose lasting knowledge isn't in the areas yet.",
        _needs_promotion,
    ),
    (
        "Unfiled source notes",
        "No topic and no area, so only a search finds them.",
        _unfiled,
    ),
    (
        "Frontmatter names a missing note",
        "A `topics:` or `areas:` entry with no note, or a dropped topic.",
        _missing_slugs,
    ),
    ("Broken links", "Links to notes that don't exist.", _broken_links),
    (
        "Duplicate note names",
        "A `[[link]]` to one of these could mean either note.",
        _duplicates,
    ),
    (
        "People without a note",
        f"Names in {RECURRING}+ source notes that match no person or alias.",
        _unknown_people,
    ),
    (
        "Bullets without a source",
        "Facts, decisions and constraints that cite no note.",
        _uncited,
    ),
    (
        "Mentioned without a note",
        f"Tickets and pull requests that {RECURRING} or more notes mention.",
        _unnoted_tickets,
    ),
)


def render(vault) -> list:
    """The lint page's lines: one section per check that found something."""
    lines = []
    for title, hint, check in CHECKS:
        found = check(vault)
        if found:
            lines += [f"## {title} ({len(found)})", "", hint, "", *found, ""]
    return lines or ["Nothing to tidy.", ""]
