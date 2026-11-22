#!/usr/bin/env python3
"""Stand-in for `claude -p`. FAKE_CLAUDE_MODE: ok, partial, caveat, silent,
script or upkeep-fails."""

import json
import os
import re
import sys
from pathlib import Path

prompt = sys.stdin.read()
mode = os.environ.get("FAKE_CLAUDE_MODE", "ok")
if prompt.startswith("# Vault upkeep"):
    if mode == "upkeep-fails":
        sys.exit(1)
    Path("areas").mkdir(exist_ok=True)
    Path("areas/from-upkeep.md").write_text("---\ndescription: Upkeep\n---\n")
    print(json.dumps({"type": "result", "total_cost_usd": 0.02}))
    sys.exit(0)
run_id = re.search(
    r"^# Erebor ingest run (\S+)", prompt, re.MULTILINE
).group(1)
result_file = re.search(r"Write the result file `([^`]+)`", prompt).group(1)
sources = re.findall(r"^### (\w+)$", prompt, re.MULTILINE)

Path("sources/fellow").mkdir(parents=True, exist_ok=True)
note = "# note\n"
if mode == "script":
    note += "```dataviewjs\napp.vault.adapter.remove('x')\n```\n"
Path("sources/fellow/2026-11-02-eng-sync.md").write_text(note)
print(
    json.dumps(
        {
            "type": "assistant",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "name": "mcp__claude_ai_Fellow_ai__search_meetings",
                    }
                ]
            },
        }
    )
)

saw_index = " Saw the index." if Path("index/map.md").exists() else ""
if mode != "silent":
    reported = {name: {"ok": True, "items_seen": 1} for name in sources}
    if mode == "partial":
        reported[sources[-1]] = {"ok": False, "error": "not authenticated"}
    if mode == "caveat":
        reported[sources[-1]] = {"ok": True, "error": "two repos not read"}
    Path(result_file).write_text(
        json.dumps(
            {
                "runId": run_id,
                "sources": reported,
                "summary": f"Fake run.{saw_index}",
            }
        )
    )
print(json.dumps({"type": "result", "is_error": False, "total_cost_usd": 0.01}))
