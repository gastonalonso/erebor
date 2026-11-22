"""Installs the knowledge-vault skill so other Claude sessions can load it."""

from __future__ import annotations

import subprocess
from pathlib import Path

import vault_files

SKILL_SOURCE = Path(__file__).resolve().parent / "skills/knowledge-vault"
SKILLS_HOME = Path.home() / ".claude/skills"


def install(vault: Path, skills_home: Path) -> Path:
    """Write the knowledge-vault skill, pointed at this vault."""
    target = skills_home / SKILL_SOURCE.name
    target.mkdir(parents=True, exist_ok=True)
    text = (SKILL_SOURCE / "SKILL.md").read_text()
    (target / "SKILL.md").write_text(text.replace("@@VAULT@@", str(vault)))
    _exclude_from_host_repo(target)
    return target


def _exclude_from_host_repo(path: Path) -> None:
    """Keep the installed copy out of a git repo holding the skills folder."""
    try:
        top = Path(vault_files.git(path, "rev-parse", "--show-toplevel"))
        git_dir = Path(vault_files.git(path, "rev-parse", "--absolute-git-dir"))
    except subprocess.CalledProcessError:
        return
    exclude = git_dir / "info/exclude"
    entry = f"/{path.resolve().relative_to(top)}/"
    lines = exclude.read_text().splitlines() if exclude.exists() else []
    if entry not in lines:
        exclude.parent.mkdir(exist_ok=True)
        exclude.write_text("\n".join([*lines, entry]) + "\n")
