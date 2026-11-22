"""Runs `claude -p` as a child process and interprets how it ended."""

from __future__ import annotations

import json
import signal
import subprocess
from pathlib import Path

CANCEL_SIGNALS = (signal.SIGTERM, signal.SIGINT)


def tool_label(event) -> list:
    if event.get("type") != "assistant":
        return []
    return [
        block["name"].removeprefix("mcp__claude_ai_")
        for block in event.get("message", {}).get("content", [])
        if block.get("type") == "tool_use"
    ]


def stream_events(lines, log) -> dict:
    """Log every event, echo tool calls, return the final result event."""
    result_event = {}
    for line in lines:
        log.write(line)
        log.flush()
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "result":
            result_event = event
        for label in tool_label(event):
            print(f"  → {label}", flush=True)
    return result_event


def run_claude(
    command, prompt: str, vault: Path, log_dir: Path, run_id: str
) -> dict:
    """Run Claude, streaming events to a log; SIGTERM/SIGINT cancel it."""
    log_file = log_dir / f"{run_id}.jsonl"
    stderr_file = log_dir / f"{run_id}.stderr"
    cancelled = False
    with (
        open(log_file, "w") as log,
        open(stderr_file, "w") as stderr,
        subprocess.Popen(
            command,
            cwd=vault,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr,
            text=True,
        ) as process,
    ):

        def cancel(*_):
            nonlocal cancelled
            cancelled = True
            process.terminate()

        previous = {sig: signal.signal(sig, cancel) for sig in CANCEL_SIGNALS}
        try:
            process.stdin.write(prompt)
            process.stdin.close()
            result_event = stream_events(process.stdout, log)
            exit_code = process.wait()
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    return {
        "exit_code": exit_code,
        "cancelled": cancelled,
        "claude": result_event,
        "log_file": log_file,
        "stderr": stderr_file.read_text()[-500:],
    }


def failure_reason(run, result) -> str | None:
    if run["cancelled"]:
        return "Cancelled"
    if result is not None:
        return None
    if run["claude"].get("is_error"):
        return run["claude"].get("result")
    return (
        run["stderr"].strip()
        or f"Claude exited {run['exit_code']} without writing a result file"
    )
