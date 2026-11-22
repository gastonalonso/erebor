#!/usr/bin/env python3
"""Pull new items from work sources into an Obsidian vault with `claude -p`."""

from __future__ import annotations

import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import cli
import core
import runner
import skill
import upkeep
import vault_files
import vault_index

REPO_DIR = Path(__file__).resolve().parent
PROMPT_TEMPLATE = REPO_DIR / "prompt.md"
SOURCES_FILE = REPO_DIR / "sources.json"
EXIT_OK, EXIT_FAILED, EXIT_PARTIAL = 0, 1, 2
EXIT_USAGE, EXIT_LOCKED = 64, 75
EXIT_FOR_STATUS = {"ok": EXIT_OK, "partial": EXIT_PARTIAL}
CLAUDE_FALLBACK = Path.home() / ".local/bin/claude"


class UsageError(Exception):
    pass


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def write_json(path: Path, data) -> None:
    """Atomic write, so a reader such as the plugin never sees half a file."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    tmp.replace(path)


def load_config(path: Path) -> dict:
    if not path.exists():
        shutil.copy(REPO_DIR / "config.example.json", path)
        raise UsageError(
            f"Created {path} from the example. Review it, then run again."
        )
    config = json.loads(path.read_text())
    config["vault"] = Path(config["vault"]).expanduser()
    return config


def find_claude(config) -> str:
    claude = config.get("claude_bin") or shutil.which("claude")
    if claude is None and CLAUDE_FALLBACK.exists():
        claude = str(CLAUDE_FALLBACK)
    if claude is None:
        raise UsageError("claude not found; set claude_bin in config.json")
    return claude


def plan_sources(config, names, cursors, override_days) -> dict:
    now = datetime.now(timezone.utc)
    window = {
        "initial_days": config.get("initial_lookback_days", 3),
        "max_days": config.get("max_lookback_days", 7),
        "override_days": override_days,
    }
    planned = {}
    for name in names:
        options = {
            k: v
            for k, v in config["sources"].get(name, {}).items()
            if k != "enabled"
        }
        planned[name] = {
            "since": core.compute_since(cursors.get(name), now, window),
            "options": options,
        }
    return planned


def build_prompt(planned, catalog, run_values, exclusions) -> str:
    return core.render_prompt(
        PROMPT_TEMPLATE.read_text(),
        {
            **run_values,
            "TODAY": f"{datetime.now():%Y-%m-%d}",
            "SOURCES": core.render_sources(planned, catalog),
            "EXCLUSIONS": "\n".join(f"- {e}" for e in exclusions) or "None.",
        },
    )


def claude_command(config, vault: str, tools) -> list:
    # Only project settings (the vault has none), so the user's global allow
    # list can't widen what an unattended run may do.
    command = [find_claude(config), "-p", "--setting-sources", "project"]
    command += ["--permission-mode", "dontAsk"]
    command += ["--output-format", "stream-json", "--verbose"]
    if config.get("model"):
        command += ["--model", config["model"]]
    command += ["--disallowedTools", *core.disallowed_tools(vault, tools)]
    return command + ["--allowedTools", *tools]  # variadic flag: keep it last


def upkeep_command(config, vault: Path) -> list:
    """The upkeep pass reads no source, so it gets no source tools."""
    return claude_command(
        config, str(vault), core.allowed_tools(str(vault), [], {})
    )


def run_upkeep(config) -> int:
    vault = config["vault"]
    outcome = upkeep.standalone(upkeep_command(config, vault), vault)
    if outcome is None:
        print("No topic needs promoting.")
        return EXIT_OK
    verdict = "done" if outcome["ok"] else "failed"
    print(f"Upkeep {verdict}: {', '.join(outcome['topics'])}")
    return EXIT_OK if outcome["ok"] else EXIT_FAILED


def ingest(args, config) -> int:
    vault = config["vault"]
    state = vault / ".state"
    log_dir = state / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    cursor_file, last_run_file = state / "cursor.json", state / "last-run.json"
    result_file = state / "run-result.json"

    catalog = json.loads(SOURCES_FILE.read_text())
    names = args.source or [
        n for n, s in config["sources"].items() if s.get("enabled")
    ]
    if not names:
        raise UsageError("no sources enabled")
    tools = core.allowed_tools(str(vault), names, catalog)
    cursors = read_json(cursor_file, {})
    planned = plan_sources(config, names, cursors, args.lookback)

    started_at = core.to_iso(datetime.now(timezone.utc))
    run_id = datetime.now().strftime(core.RUN_ID_FORMAT)
    prompt = build_prompt(
        planned,
        catalog,
        {
            "RUN_ID": run_id,
            "VAULT": str(vault),
            "NOW": started_at,
            "RESULT_FILE": str(result_file),
        },
        config.get("exclusions", []),
    )
    if args.dry_run:
        print(prompt, "\n--- allowed tools ---", *tools, sep="\n")
        return EXIT_OK

    command = claude_command(config, str(vault), tools)

    with vault_files.RunLock(state / "run.lock"):
        (log_dir / f"{run_id}.prompt.md").write_text(prompt)
        result_file.unlink(missing_ok=True)
        write_json(
            last_run_file,
            {
                "runId": run_id,
                "status": "running",
                "startedAt": started_at,
                "sources": {
                    n: {"since": p["since"]} for n, p in planned.items()
                },
            },
        )
        print(f"Run {run_id} → {vault}")
        print(
            "Sources: "
            + ", ".join(f"{n} since {p['since']}" for n, p in planned.items())
        )

        # Interactive sessions and the dashboard change notes between runs.
        vault_index.rebuild(vault)
        run = runner.run_claude(command, prompt, vault, log_dir, run_id)
        result = read_json(result_file)
        if not core.is_result_for_run(result, run_id):
            result = None
        upkeep_run = None
        if result is not None and not run["cancelled"]:
            upkeep_run = upkeep.run(
                upkeep_command(config, vault),
                vault,
                log_dir=log_dir,
                run_id=run_id,
            )
        neutralized = vault_files.neutralize_scripts(vault)
        lint_entries = vault_index.rebuild(vault)
        summary = core.summarize_run(
            planned,
            result,
            {
                "exit_code": run["exit_code"],
                "failure": runner.failure_reason(run, result),
                "claude": run["claude"],
            },
        )
        if upkeep_run:
            summary = core.merge_upkeep(summary, upkeep_run)
        if neutralized:
            summary = core.flag_scripts(summary, neutralized)
        if not run["cancelled"]:
            cursors.update(
                {name: started_at for name in core.succeeded_sources(summary)}
            )
            write_json(cursor_file, cursors)
        final = {
            "runId": run_id,
            "startedAt": started_at,
            "finishedAt": core.to_iso(datetime.now(timezone.utc)),
            **summary,
            "lintEntries": lint_entries,
            "logFile": str(run["log_file"]),
            "commit": vault_files.commit_vault(
                vault, f"Ingest {run_id} ({summary['status']})"
            ),
        }
        write_json(last_run_file, final)
        with open(state / "history.jsonl", "a") as history:
            history.write(json.dumps(final) + "\n")
        vault_files.prune_logs(log_dir)

    print(core.format_report(final))
    print(f"  log: {final['logFile']}")
    return EXIT_FOR_STATUS.get(final["status"], EXIT_FAILED)


def main(argv=None) -> int:
    args = cli.parse_args(argv)
    try:
        config = load_config(
            Path(os.environ.get("EREBOR_CONFIG", REPO_DIR / "config.json"))
        )
        if args.install_skill:
            target = skill.install(config["vault"], skill.SKILLS_HOME)
            print(f"Installed the knowledge-vault skill at {target}")
            return EXIT_OK
        vault_files.warn_if_protected(config["vault"])
        if args.init or not (config["vault"] / "CLAUDE.md").exists():
            vault_files.init_vault(
                config["vault"],
                REPO_DIR / "vault-template",
                config.get("seed_topics", []),
            )
        if args.init or args.index:
            entries = vault_index.rebuild(config["vault"])
            print(f"Index rebuilt: {entries} entries in index/lint.md")
            return EXIT_OK
        if args.upkeep:
            return run_upkeep(config)
        return ingest(args, config)
    except vault_files.LockedError as error:
        print(f"error: {error}", file=sys.stderr)
        return EXIT_LOCKED
    except (UsageError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main())
