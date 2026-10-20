# paceline

**Your agents take turns.**

paceline is a [Claude Code](https://code.claude.com) plugin that enforces a minimum gap between
calls to the same external host — **machine-wide**, across every Claude Code session, subagent,
terminal and script you have running. It is a `PreToolUse`/`PostToolUse` hook pair with
lock-file state on disk, plus a small CLI so your own scripts can share the same throttle.

A paceline is a line of cyclists taking turns at the front. Nobody sprints ahead.

```
$ paceline test --interval 2000 --calls 5 --parallel 5
paceline test: 5 call(s), minimum interval 2000 ms, up to 5 hook processes at once

  call #0  pre took 48 ms     released at +82 ms
  call #3  pre took 2078 ms   released at +2129 ms   paceline: waited 2.0s for paceline-test (paceline.test)
  call #2  pre took 4129 ms   released at +4170 ms   paceline: waited 4.1s for paceline-test (paceline.test)
  call #4  pre took 6162 ms   released at +6218 ms   paceline: waited 6.1s for paceline-test (paceline.test)
  call #1  pre took 8217 ms   released at +8266 ms   paceline: waited 8.2s for paceline-test (paceline.test)

  finish→start gaps recorded by the hooks (ms): 2003, 2003, 2003, 2004   min 2003   required ≥ 2000
  wall time 8.27 s   required ≥ 8.00 s

PASS: 5/5 calls finished, 4/4 gaps ≥ 2000 ms
```

## Why

On October 6, 2026 a script at [Rulestack](https://dev.to/rulestack/two-claude-code-hooks-make-our-agent-wait-10-s-between-browser-calls-to-one-site-measured-at-2g19)
sent 103 follow requests to a social site in 67 seconds. It respected a *daily* cap of 150, but
nothing spaced the requests, and the account was suspended within six minutes. They looked for a
Claude Code setting that enforces a minimum gap between tool calls and found none, so they
hand-rolled a hook pair for their project and measured gaps of exactly 10,000 ms. Their post ends
by asking how other people pace their agents.

The same week, someone on r/AI_Agents woke up to an agent that had retried a failing tool
31,000 times overnight. Same missing primitive, different axis.

paceline is that primitive, generalised and packaged:

- **Finish-to-start gaps.** The clock starts when the previous call to that site *finished*,
  not when it started. Slow responses never let two requests overlap.
- **Machine-wide.** State lives on disk under one lock per target. Two Claude Code windows, a
  subagent, and a cron job all stand in the same line.
- **Hooks, not prompts.** A `CLAUDE.md` rule asks the model to wait. A `PreToolUse` hook *makes*
  it wait, and blocks the call if the hook itself crashes or times out.
- **Opt-in.** Nothing is paced until you write a rule. Surprise waits are worse than none.

## Install

Requires Claude Code **2.1.295 or later** (for `onFailure: "block"`) and Node 20+.

Inside Claude Code:

```
/plugin marketplace add joseeantonior/paceline
/plugin install paceline@paceline
```

Or from your shell:

```bash
claude plugin marketplace add joseeantonior/paceline
claude plugin install paceline@paceline
```

For the `paceline` CLI (`status`, `reset`, `run`, `test`):

```bash
npm install -g paceline
```

To hack on it: `git clone https://github.com/joseeantonior/paceline && cd paceline && npm install && npm run build`,
then `claude --plugin-dir ./paceline` from any project. `dist/` is committed, so a marketplace
install needs no build step.

## Quick start

Create `~/.claude/paceline.json`:

```json
{
  "rules": [
    { "name": "social",     "target": "*.example.com",   "minIntervalMs": 10000 },
    { "name": "github-api", "target": "api.github.com",  "minIntervalMs": 1000 },
    { "name": "shops",      "target": "*.myshopify.com", "minIntervalMs": 2000, "perHost": true }
  ]
}
```

That is it. From the next tool call on, every `WebFetch`, `curl`, `gh`, browser navigation or
click that reaches one of those hosts waits its turn. When a call had to wait more than a second,
Claude Code shows `paceline: waited 8.2s for social (*.example.com)` and the model is told the
same, so it knows why the call stalled.

Check what is happening:

```
$ paceline status
paceline 0.1.0   state: /home/you/.cache/paceline
config: /home/you/.claude/paceline.json

TARGET                       INTERVAL  LAST CALL     NEXT ALLOWED  IN FLIGHT                         LAST HOUR  TOTAL
github-api (api.github.com)  1000ms    1.0s ago      +1s after it  WebFetch 44ms ago                 3          3
shops (a.myshopify.com)      2000ms    956ms ago     in 1.0s       —                                 1          1
social (*.example.com)       10000ms   870ms ago     in 9.1s       —                                 1          1

browser tabs mapped: 1 (41→www.example.com)
```

## Configuration

Two files, merged in order: `~/.claude/paceline.json` (user), then `<project>/.claude/paceline.json`
(project). Scalars from the project file win; `rules` merge by `name` and `refuse` by `tool`, so a
project can tighten one rule without repeating the rest. `PACELINE_CONFIG=<file>` replaces the
user file; `PACELINE_NO_PROJECT_CONFIG=1` ignores project files.

A project file can also *loosen* a user rule of the same name. If you work in repositories you do
not control, give your personal rules names a repository is unlikely to reuse, or set
`PACELINE_NO_PROJECT_CONFIG=1`.

| Key | Default | Meaning |
| --- | --- | --- |
| `rules[]` | `[]` | The targets to pace. See below. |
| `rules[].name` | — | Unique id. One throttle bucket per rule (unless `perHost`). |
| `rules[].target` | — | Host glob, or an array of them. `*` spans dots; `*.example.com` also matches `example.com`. |
| `rules[].minIntervalMs` | — | Minimum gap between the end of one call and the start of the next. |
| `rules[].perHost` | `false` | Pace each concrete host separately instead of the rule as a whole. |
| `rules[].maxPerHour` | — | Rolling cap. The call is refused (with the time of the next free slot) rather than waited for when the slot is more than `maxWaitMs` away. |
| `refuse[]` | `[]` | `{ "tool": "<name or glob>", "reason": "…" }`: deny a tool outright. Claude sees the reason. |
| `defaultMinIntervalMs` | `0` | Gap for hosts that match no rule. `0` means pass through. |
| `unknownTargetPolicy` | `"pace-all"` | A browser action on a tab whose site is not yet known: `pace-all` counts it against every rule (a `perHost` rule is counted as a whole, since the host is unknown); `ignore` lets it through. |
| `inFlightHoldMs` | `120000` | How long a claimed call blocks others if its `PostToolUse` never arrives. |
| `maxWaitMs` | `240000` | Longest a hook will wait before refusing the call with a retry hint. Capped at 290 000 because the hook itself times out (and blocks) at 300 s. |
| `notifyAfterMs` | `1000` | Waits at least this long produce a visible `paceline: waited …` message. |
| `refuseUnpaceable` | `true` | Deny `browser_batch` and `javascript_tool` scripts with 2+ `fetch(` calls when they target a paced site. |
| `readOnlyTools` | see below | Tool names that never touch the site. Your list is added to the built-in one. |
| `staleLockMs` | `900000` | A lock directory older than this is reclaimed even if its owner looks alive. |

The built-in read-only list covers Claude in Chrome tools that only look at the page:
`screenshot`, `get_page_text`, `read_page`, `find`, `list_tabs`, `tabs_context_mcp`,
`tabs_create_mcp`, `tabs_close_mcp`, `read_console_messages`, `read_network_requests`,
`gif_creator`, `resize_window`, `shortcuts_list`, `update_plan`, plus the `computer` tool's
`screenshot`, `zoom`, `wait` and `cursor_position` actions.

A full example is in [`examples/paceline.json`](examples/paceline.json).

## How a call is matched to a site

paceline does not configure tools; it reads **where the call is going** from the call itself.

| Tool | Target |
| --- | --- |
| `WebFetch`, browser `navigate`, any tool with a URL | The URL's hostname. |
| `Bash` | Every `http(s)://host` in the command, `git@host:` remotes, bare hosts after `curl`/`wget`/`http`, and `gh …` ⇒ `api.github.com`. `ls`, `npm test` and friends pass in about 45 ms. |
| Claude in Chrome actions on a tab (`computer`, `form_input`, `javascript_tool`, …) | The site that tab was last navigated to. The tab → site map is learned from `navigate` calls and from the tab lists the extension returns, and kept in `tabs.json`. Unknown tab ⇒ `unknownTargetPolicy`. |
| Other MCP tools | Any `url`, `uri`, `endpoint`, `base_url`, `href`, `host` field in the input, two levels deep. |

Hosts that match no rule are untouched (unless `defaultMinIntervalMs` is set). `WebSearch` is
never paced: it is not a site you hold an account on.

## How the gap is enforced

```
PreToolUse  ──►  resolve hosts ──► buckets (sorted) ──► for each bucket:
                                                        lock ─► in flight? wait ─► since last finish ≥ interval? ─► claim ─► unlock
PostToolUse ──►  for each claimed bucket: lastFinishedAt = now, clear in-flight, record timestamp
```

- State is in `~/.cache/paceline` (or `$XDG_CACHE_HOME/paceline`, or `PACELINE_STATE_DIR`):
  `targets/<bucket>/last.json`, a `lock/` directory per bucket, `claims/`, `tabs.json`, and
  `paceline.log`. It is deliberately not under the plugin's own data directory so that the CLI,
  `paceline run`, and hooks loaded any way at all share one throttle.
- The lock is `mkdir`: atomic on every platform. It is held only around the read-decide-write,
  never while sleeping. A lock whose owner pid is dead, or older than 15 minutes, is reclaimed.
- A claimed call that never reports back (the session crashed) blocks its bucket for
  `inFlightHoldMs`, or until the Claude Code process that made the claim is gone, whichever is
  first. `PostToolUseFailure` and `PermissionDenied` release the hold like a normal finish.
- Several buckets are claimed in sorted order, so two hooks claiming the same pair cannot deadlock.
- **Fail closed.** The hook is registered with `onFailure: "block"` and a 300 s timeout. If
  `dist/hook.js` is missing, Node is missing, the hook crashes, or a wait would outlast
  `maxWaitMs`, the call is denied with a reason Claude can read. A broken config denies external
  calls (and only those) until it is fixed. `PACELINE_DISABLED=1` turns everything off.

## CLI

```
paceline status [--json]              per-target last call, in-flight hold, next allowed slot
paceline reset <target>|--all         forget a target's state (rule name, host, or bucket key)
paceline reset --tabs                 forget the browser tab → site map
paceline run --target <host> [...] [--interval <ms>] -- <cmd> [args...]
paceline test [--interval 2000] [--calls 5] [--parallel 5]
paceline config                       show the merged configuration and where it came from
paceline log [-n 50]                  tail the audit log
paceline paths                        print the state dir and config paths
```

### `paceline run`: one throttle for everything

Hooks cover Claude Code. Everything else on the machine, your own scripts, a cron job, Codex or
OpenCode agents, can stand in the same line through `paceline run`. It waits for its turn on the
hosts you name, runs the command, and records the finish when the command exits:

```bash
paceline run --target api.github.com -- curl -s https://api.github.com/user
paceline run --target shop.myshopify.com -- node sync-inventory.js
paceline run --target api.foo.io --interval 1500 -- ./poll.sh   # ad-hoc interval, no rule needed
```

The exit code is the command's. In Codex or OpenCode, wrap the network-facing commands your agent
runs (or your API client) in `paceline run` and they pace against the same `last.json` your
Claude Code hooks use.

### `paceline test`: prove it

`paceline test` spawns N `pre` hook processes at once against a throwaway state directory, fires
the matching `post` as each one is released, then reads the claim and finish timestamps the hooks
themselves wrote. It passes only if every finish→start gap is at least the interval and the wall
time is at least `(calls − 1) × interval`. Run it after installing, and whenever you touch the
code. The CI workflow in `ci/` runs it on Linux, macOS and Windows.

## Why a hook and not a `CLAUDE.md` rule

A `CLAUDE.md` line like "wait 10 seconds between requests to example.com" is advice. The model may
follow it, may `sleep 10` in a Bash call it then forgets, and has no idea what the other three
sessions on your machine are doing. Nothing is measured and nothing is enforced.

A `PreToolUse` hook runs before the tool does, in a separate process, with the call's inputs. It
can look at a shared clock on disk, sleep until the slot is free, and refuse the call if it cannot.
Since Claude Code 2.1.295, `onFailure: "block"` means even a crashed or timed-out hook blocks the
call, which closes the one hole the Rulestack post listed.

## Gotchas

- **No gap inside one tool call.** `browser_batch` runs several browser actions in one call;
  a `javascript_tool` script may `fetch()` ten times. paceline refuses those when they target a
  paced site (`refuseUnpaceable`), because the alternative is pretending.
- **Hook waits happen before the permission prompt.** If you take five minutes to approve a call,
  the claim's hold expires after `inFlightHoldMs` and the next caller may go first. Approve
  promptly or raise the hold.
- **The browser tab → site map is heuristic.** It is learned from `navigate` calls and from URLs
  the extension returns next to tab ids. When a tab is unknown, `pace-all` over-waits rather than
  under-waits, and the message tells you so. `paceline status` shows the current map.
- **A page's own requests are not paced.** paceline spaces the agent's actions, not the dozen
  XHRs a page fires when it loads.
- **Bash matching is best-effort.** `curl $URL` with the URL in a variable is invisible. Prefer
  literal URLs in agent-issued commands, or route scripts through `paceline run`.
- **One machine.** The lock is a directory on local disk. Multi-machine pacing needs a shared
  service; see the roadmap.
- `${CLAUDE_PLUGIN_ROOT}` changes on every plugin update, which is why no state is kept there.

## Roadmap

- `type: "http"` hook variant pointing at a tiny daemon for multi-machine pacing.
- Native hook adapters for Codex and OpenCode (today they use `paceline run`).
- Per-target daily caps on top of `maxPerHour`.

## Development

```bash
npm install
npm run check        # typecheck + build + unit and end-to-end tests
node dist/cli.js test --interval 2000 --calls 5 --parallel 5
claude plugin validate --strict .
claude --plugin-dir . # try it live from another project directory
```

The GitHub Actions workflow lives at `ci/github-actions.yml`; copy it to
`.github/workflows/ci.yml` to enable it (it was committed outside that path because the token that
pushed this repository had no `workflow` scope). It runs the type check, unit and end-to-end
tests, `dist/` freshness, the concurrency proof on Linux, macOS and Windows, and
`claude plugin validate --strict`.

The hook is one bundled file (`dist/hook.js`, no runtime dependencies) so a non-matching call
costs about 45 ms. `computeWaitMs` and the lock reclaim logic are pure functions with their own
tests; everything else is plumbing.

## Credits

Design: [Rulestack's pacing hook pair](https://dev.to/rulestack/two-claude-code-hooks-make-our-agent-wait-10-s-between-browser-calls-to-one-site-measured-at-2g19).
paceline generalises it from one project to a plugin, adds target resolution from tool inputs,
per-project config, fail-closed semantics, and a CLI.

## License

MIT
