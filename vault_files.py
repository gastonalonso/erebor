"""Vault filesystem work: scaffolding, git, the run lock, log retention."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import core

LOG_RETENTION_SECONDS = 30 * 24 * 3600
PROTECTED_DIRS = ("Documents", "Desktop", "Downloads")


class LockedError(Exception):
    pass


def warn_if_protected(vault: Path) -> None:
    if any(vault.is_relative_to(Path.home() / d) for d in PROTECTED_DIRS):
        print(
            "warning: a future launchd schedule can't write to a vault under "
            "~/Documents, ~/Desktop or ~/Downloads (macOS privacy rules).",
            file=sys.stderr,
        )


def git(vault: Path, *args) -> str:
    return subprocess.run(
        ["git", "-C", str(vault), *args],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def init_vault(vault: Path, template: Path, seed_topics) -> None:
    shutil.copytree(
        template,
        vault,
        dirs_exist_ok=True,
        copy_function=_copy_if_missing,
    )
    for title in seed_topics:
        note = vault / f"topics/{core.slugify(title)}.md"
        if not note.exists():
            note.write_text(core.seed_topic_note(title, datetime.now()))
    if not (vault / ".git").exists():
        git(vault, "init", "-q")
        git(vault, "add", "-A")
        git(vault, "commit", "-qm", "Initialize vault")
    print(f"Vault ready at {vault}")


def _copy_if_missing(src, dst):
    if not os.path.exists(dst):
        shutil.copy2(src, dst)


class RunLock:
    """Directory lock holding the owner's pid; reclaimed if that pid is dead."""

    def __init__(self, path: Path):
        self.path = path

    def __enter__(self):
        try:
            self.path.mkdir()
        except FileExistsError:
            holder = (
                (self.path / "pid").read_text().strip()
                if (self.path / "pid").exists()
                else ""
            )
            if holder and _is_alive(int(holder)):
                raise LockedError(
                    f"Another run is in progress (pid {holder})."
                ) from None
            shutil.rmtree(self.path)
            self.path.mkdir()
        (self.path / "pid").write_text(str(os.getpid()))
        return self

    def __exit__(self, *exc):
        shutil.rmtree(self.path, ignore_errors=True)


def _is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def commit_vault(vault: Path, message: str) -> str | None:
    if not (vault / ".git").exists():
        return None
    try:
        if not git(vault, "status", "--porcelain"):
            return None
        git(vault, "add", "-A")
        git(vault, "commit", "-qm", message)
        return git(vault, "rev-parse", "--short", "HEAD")
    except subprocess.CalledProcessError as error:
        print(
            f"warning: vault commit failed: {error.stderr.strip()}",
            file=sys.stderr,
        )
        return None


def prune_logs(log_dir: Path) -> None:
    cutoff = time.time() - LOG_RETENTION_SECONDS
    for log in log_dir.iterdir():
        if log.stat().st_mtime < cutoff:
            log.unlink()


def neutralize_scripts(vault: Path) -> list:
    """Disable code blocks in notes ingest may write; return what changed."""
    changed = []
    for note in vault.rglob("*.md"):
        relative = note.relative_to(vault)
        if relative.parts[0] in core.READ_ONLY_DIRS + (".git", ".state"):
            continue
        text = note.read_text()
        safe = core.neutralize_scripts(text)
        if safe != text:
            note.write_text(safe)
            changed.append(str(relative))
    return sorted(changed)
