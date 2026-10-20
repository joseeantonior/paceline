# Changelog

## 0.1.1 — 2026-10-20

- Release tooling: `npm run bump -- <version>` sets the version in `package.json`,
  `package-lock.json`, the plugin manifest and the CLI together, and `npm run check`
  fails when they disagree. First npm release published through the workflow.
- No runtime changes since 0.1.0.

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

### Hardening after independent review (same day)

- Tab → site map is learned only from `navigate` and the extension's own tab
  listings, never from page content.
- Stale-lock reclaim renames the lock away (one winner) and re-verifies before
  deleting; a reclaimed-from-under-us mkdir is retried, not thrown.
- A hook that throws after claiming some buckets releases them first.
- `unknownTargetPolicy: pace-all` also claims existing per-host buckets.
- Every `mcp__*` tool reaches the hook (README promised this; the matcher did not).
- `paceline reset` understands per-host rules and glob targets.
- Clock steps backwards no longer lock a bucket; `maxWaitMs` capped under the hook timeout.
- `reclaimOnOwnerExit` config switch; `staleLockMs` is honoured by the hook.
