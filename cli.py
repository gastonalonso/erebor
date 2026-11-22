"""The command-line flags of `run.sh`."""

from __future__ import annotations

import argparse

DESCRIPTION = (
    "Pull new items from work sources into an Obsidian vault with `claude -p`."
)


def parse_args(argv):
    parser = argparse.ArgumentParser(description=DESCRIPTION)
    parser.add_argument(
        "--init",
        action="store_true",
        help="create or refresh the vault, then exit",
    )
    parser.add_argument(
        "--install-skill",
        action="store_true",
        help="install the knowledge-vault skill for this vault, then exit",
    )
    parser.add_argument(
        "--index",
        action="store_true",
        help="rebuild the vault's index, then exit",
    )
    parser.add_argument(
        "--upkeep",
        action="store_true",
        help="promote topics to areas and tidy the vault, then exit",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print the prompt and tools, don't run",
    )
    parser.add_argument(
        "--lookback",
        type=int,
        metavar="DAYS",
        help="ignore cursors, fetch the last DAYS days",
    )
    parser.add_argument(
        "--source",
        action="append",
        metavar="NAME",
        help="run only this source (repeatable)",
    )
    return parser.parse_args(argv)
