# Changelog

## 0.1.0 — 2026-10-20

First release.

- PreToolUse / PostToolUse / PostToolUseFailure / PermissionDenied hook pair enforcing a
  finish-to-start minimum interval per external host, machine-wide.
- Targets resolved from `WebFetch` URLs, `Bash` commands (`curl`, `wget`, `gh`, git remotes),
  Claude in Chrome tabs (tab → site map learned from navigations and results), and any
  `url`/`uri`/`endpoint` field in other MCP tool inputs.
- `~/.claude/paceline.json` user config, overridden per project by `.claude/paceline.json`.
- `refuse` rules, built-in refusal of `browser_batch` and multi-`fetch()` scripts on paced sites.
- Optional `maxPerHour` rolling cap and `perHost` buckets per rule.
- CLI: `status`, `reset`, `run`, `test`, `config`, `log`, `paths`.
- Fail-closed: hook crashes, timeouts and invalid config block external calls.
