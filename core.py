"""Pure logic for an ingest run: time windows, prompt rendering, run outcome."""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone

ISO_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
RUN_ID_FORMAT = "%Y-%m-%dT%H%M%S"
# Re-read the last hour so items straddling the previous run aren't missed.
CURSOR_OVERLAP = timedelta(hours=1)
READ_ONLY_DIRS = (".claude", ".obsidian", "dashboards", "index")
SCRIPT_FENCE = re.compile(r"^(\s*(?:`{3,}|~{3,})\s*)dataviewjs\b", re.MULTILINE)
BUILTIN_TOOLS = ["Read", "Glob", "Grep", "ToolSearch"]
NOT_REPORTED = "Not reported by the run"


def to_iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime(ISO_FORMAT)


def from_iso(text: str) -> datetime:
    return datetime.strptime(text, ISO_FORMAT).replace(tzinfo=timezone.utc)


def compute_since(cursor, now, window) -> str:
    """Fetch window start; `window` has initial/max/override days."""
    if window.get("override_days") is not None:
        return to_iso(now - timedelta(days=window["override_days"]))
    if not cursor:
        return to_iso(now - timedelta(days=window["initial_days"]))
    floor = now - timedelta(days=window["max_days"])
    return to_iso(max(from_iso(cursor) - CURSOR_OVERLAP, floor))


def slugify(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")


def allowed_tools(vault: str, source_names, catalog) -> list:
    """Read-only connector tools for the sources, plus vault-confined edits."""
    # `//` marks an absolute path in Claude Code permission rules.
    tools = BUILTIN_TOOLS + [f"Edit(/{vault}/**)"]
    for name in source_names:
        if name not in catalog:
            raise ValueError(f"unknown source '{name}' (see sources.json)")
        if not catalog[name]["tools"]:
            raise ValueError(
                f"source '{name}' has no tools configured in sources.json"
            )
        tools += catalog[name]["tools"]
    return tools


def disallowed_tools(vault: str, allowed) -> list:
    """Keep settings, plugins, dashboards and the index read-only."""
    # Project settings in .claude/ would widen the next run's permissions.
    blocked = [f"Edit(/{vault}/{folder}/**)" for folder in READ_ONLY_DIRS]
    # Claude Code runs read-only commands such as `cat` without an allow rule.
    needs_shell = any(tool.startswith("Bash(") for tool in allowed)
    return blocked if needs_shell else blocked + ["Bash"]


def neutralize_scripts(text: str) -> str:
    """Disable DataviewJS blocks and inline queries, which run as code."""
    text = SCRIPT_FENCE.sub(r"\1text", text)
    return text.replace("`$=", "`$ =")


def seed_topic_note(title: str, today: datetime) -> str:
    quoted = json.dumps(title)  # a JSON string is valid YAML
    return (
        f"---\ntopic: {slugify(title)}\nstatus: active\n"
        f"description: {quoted}\naliases: [{quoted}]\n"
        f"last_updated: {today:%Y-%m-%d}\n---\n\n"
        "## Current state\n\nSeeded by hand; no evidence captured yet.\n"
    )


def render_sources(planned, catalog) -> str:
    sections = []
    for name, plan in planned.items():
        sections.append(
            f"### {name}\n\n"
            f"- since: `{plan['since']}`\n"
            f"- options: `{json.dumps(plan['options'])}`\n\n"
            f"{catalog[name]['instructions']}\n"
        )
    return "\n".join(sections)


def render_prompt(template: str, values: dict) -> str:
    for key, value in values.items():
        template = template.replace(f"@@{key}@@", value)
    return template


def is_result_for_run(result, run_id: str) -> bool:
    return isinstance(result, dict) and result.get("runId") == run_id


def fetched_fully(source) -> bool:
    """A source marked ok that still reports a problem keeps its cursor."""
    return source.get("ok") is True and not source.get("error")


def summarize_run(planned, result, outcome) -> dict:
    """Merge the plan, Claude's result file and process outcome into a status.

    `outcome` holds exit_code, failure (str or None) and claude (the
    stream-json result event).
    """
    reported = (result or {}).get("sources", {})
    sources = {
        name: {
            **reported.get(name, {"ok": False, "error": NOT_REPORTED}),
            "since": plan["since"],
        }
        for name, plan in planned.items()
    }
    ok_count = sum(1 for source in sources.values() if source.get("ok") is True)
    failure = outcome.get("failure")
    if failure or ok_count == 0:
        status = "failed"
    elif not all(map(fetched_fully, sources.values())) or outcome["exit_code"]:
        status = "partial"
    else:
        status = "ok"
    claude = outcome.get("claude") or {}
    return {
        "status": status,
        "error": failure or None,
        "exitCode": outcome["exit_code"],
        "sources": sources,
        "topicsUpdated": (result or {}).get("topics_updated", []),
        "topicsProposed": (result or {}).get("topics_proposed", []),
        "areasUpdated": (result or {}).get("areas_updated", []),
        "summary": (result or {}).get("summary"),
        "costUsd": claude.get("total_cost_usd"),
        "tokens": token_counts(claude.get("usage") or {}),
        "permissionDenials": len(claude.get("permission_denials") or []),
    }


def merge_upkeep(summary: dict, upkeep: dict) -> dict:
    """Fold the upkeep pass into a run's summary: its cost and outcome count."""
    claude = upkeep["claude"]
    tokens = token_counts(claude.get("usage") or {})
    costs = [summary["costUsd"], claude.get("total_cost_usd")]
    known_costs = [cost for cost in costs if cost is not None]
    failed_ok_run = summary["status"] == "ok" and not upkeep["ok"]
    return {
        **summary,
        "status": "partial" if failed_ok_run else summary["status"],
        "costUsd": sum(known_costs) if known_costs else None,
        "tokens": {key: summary["tokens"][key] + tokens[key] for key in tokens},
        "upkeep": {"topics": upkeep["topics"], "ok": upkeep["ok"]},
    }


def token_counts(usage) -> dict:
    """Input includes cache reads and writes, which the API counts apart."""
    cached = usage.get("cache_read_input_tokens", 0)
    return {
        "input": usage.get("input_tokens", 0)
        + usage.get("cache_creation_input_tokens", 0)
        + cached,
        "cached": cached,
        "output": usage.get("output_tokens", 0),
    }


def _compact(count) -> str:
    for size, suffix in ((1_000_000, "M"), (1_000, "K")):
        if count >= size:
            return f"{count / size:.3g}{suffix}"
    return str(count)


def format_cost(summary) -> str | None:
    if summary.get("costUsd") is None:
        return None
    tokens = summary["tokens"]
    return (
        f"  cost: ${summary['costUsd']:.2f} · "
        f"{_compact(tokens['input'])} tokens in "
        f"({_compact(tokens['cached'])} cached), "
        f"{_compact(tokens['output'])} out"
    )


def flag_scripts(summary, notes) -> dict:
    """A run that wrote code into notes is at best partial."""
    status = "partial" if summary["status"] == "ok" else summary["status"]
    return {**summary, "status": status, "scriptsNeutralized": notes}


def succeeded_sources(summary) -> list:
    return [
        name
        for name, source in summary["sources"].items()
        if fetched_fully(source)
    ]


def _source_line(name, source) -> str:
    if not source.get("ok"):
        return f"  ✗ {name}  {source.get('error') or 'failed'}"
    detail = (
        f"{source.get('items_seen', 0)} seen, "
        f"{source.get('notes_written', 0)} written, "
        f"{source.get('notes_updated', 0)} updated"
    )
    if source.get("error"):
        return f"  ⚠ {name}  {detail} · {source['error']}"
    return f"  ✓ {name}  {detail}"


def format_report(summary) -> str:
    headline = summary.get("summary") or summary.get("error") or ""
    lines = [f"\n{summary['status'].upper()}  {headline}"]
    lines += [
        _source_line(name, source)
        for name, source in summary["sources"].items()
    ]
    if summary.get("scriptsNeutralized"):
        notes = ", ".join(summary["scriptsNeutralized"])
        lines.append(f"  ⚠ disabled script blocks in: {notes}")
    upkeep = summary.get("upkeep")
    if upkeep:
        mark = "✓" if upkeep["ok"] else "✗"
        lines.append(f"  {mark} upkeep  {', '.join(upkeep['topics'])}")
    if summary.get("lintEntries"):
        lines.append(
            f"  ⚑ {summary['lintEntries']} entries to tidy in index/lint.md"
        )
    cost = format_cost(summary)
    if cost:
        lines.append(cost)
    return "\n".join(lines)
