"""The upkeep pass: a headless run that promotes topics and tidies lint."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import core
import runner
import vault_files
import vault_index
import vault_lint
import vault_notes

PROMPT_TEMPLATE = Path(__file__).resolve().parent / "upkeep.md"
# A pass stays short; a backlog drains over the runs that follow.
BATCH_SIZE = 5


def queue(vault: Path) -> list:
    """The next topics to promote, archived ones first."""
    notes = vault_index.Vault(vault_notes.load(vault))
    return vault_lint.needs_promotion(notes)[:BATCH_SIZE]


def _topic_line(topic) -> str:
    status = topic.meta.get("status")
    promoted = topic.meta.get("promoted") or "never"
    return f"   - [[{topic.name}]] ({status}, promoted {promoted})"


def run(command: list, vault: Path, *, log_dir: Path, run_id: str):
    """Promote the topics that need it; None when no topic does."""
    topics = queue(vault)
    if not topics:
        return None
    prompt = core.render_prompt(
        PROMPT_TEMPLATE.read_text(),
        {
            "RUN_ID": run_id,
            "VAULT": str(vault),
            "TODAY": f"{datetime.now():%Y-%m-%d}",
            "TOPICS": "\n".join(_topic_line(topic) for topic in topics),
        },
    )
    name = f"{run_id}.upkeep"
    (log_dir / f"{name}.prompt.md").write_text(prompt)
    outcome = runner.run_claude(command, prompt, vault, log_dir, name)
    claude = outcome["claude"]
    finished = bool(claude) and not claude.get("is_error")
    return {
        "topics": [topic.name for topic in topics],
        "ok": outcome["exit_code"] == 0 and finished,
        "claude": claude,
    }


def standalone(command: list, vault: Path):
    """Run only the upkeep pass, as its own locked and committed run."""
    state = vault / ".state"
    log_dir = state / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    run_id = datetime.now().strftime(core.RUN_ID_FORMAT)
    with vault_files.RunLock(state / "run.lock"):
        vault_index.rebuild(vault)
        outcome = run(command, vault, log_dir=log_dir, run_id=run_id)
        vault_files.neutralize_scripts(vault)
        vault_index.rebuild(vault)
        vault_files.commit_vault(vault, f"Upkeep {run_id}")
    return outcome
