#!/bin/bash
# Entry point for ingest.py. GUI apps such as Obsidian don't inherit the login
# shell's PATH, so the usual locations of python3 and claude are added here.
export PATH="$HOME/.local/bin:$HOME/homebrew/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
exec python3 "$(dirname "$0")/ingest.py" "$@"
