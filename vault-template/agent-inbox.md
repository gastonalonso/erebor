# Agent inbox

Claude sessions add a line here, on their own, after they use the vault:
`- YYYY-MM-DD · <folder> · <kind> — text`. The kinds are `used`, `gap`,
`stale`, `link` and `fact`. The next ingest run files each line under
`sources/agent/` and removes it from here. A line it can't file stays, with a
note saying why.
