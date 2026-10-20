import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError, hostMatches, loadConfig, ruleTargets, type Config } from "./config.js";
import { bucketsFor, pace, release, type Bucket } from "./pacer.js";
import { projectConfigPath, stateDir, userConfigPath } from "./paths.js";
import { computeWaitMs, hostKey, pidAlive, ruleKey, Store, type LastRecord } from "./state.js";

const VERSION = "0.1.1";

const HELP = `paceline ${VERSION} — your agents take turns.

Usage:
  paceline status [--json]              per-target last call, in-flight hold, next allowed slot
  paceline reset <target>|--all         forget a target's state (rule name, host, or bucket key)
  paceline reset --tabs                 forget the browser tab → site map
  paceline run [--target <host>]... [--interval <ms>] -- <cmd> [args...]
                                        run a command under the same throttle the hooks use
  paceline test [--interval 2000] [--calls 5] [--parallel 5]
                                        prove the gap with concurrent hook processes
  paceline config                       show the merged configuration and where it came from
  paceline log [-n 50]                  tail the audit log
  paceline paths                        print the state dir and config paths

Environment:
  PACELINE_STATE_DIR   state directory (default $XDG_CACHE_HOME/paceline or ~/.cache/paceline)
  PACELINE_CONFIG      user config file (default ~/.claude/paceline.json)
  PACELINE_DISABLED=1  hooks pass every call through
  PACELINE_DEBUG_TABS=1 log each browser tab listing and what was parsed from it
`;

function die(msg: string, code = 1): never {
  process.stderr.write(`paceline: ${msg}\n`);
  process.exit(code);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) die(`${name} needs a value`);
  return v;
}
function flags(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) die(`${name} needs a value`);
      out.push(v);
      i++;
    }
  }
  return out;
}
function intFlag(args: string[], name: string, dflt: number): number {
  const v = flag(args, name);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) die(`${name} must be a non-negative number`);
  return Math.floor(n);
}

function loadCfg(): { config: Config; files: string[] } {
  try {
    return loadConfig([userConfigPath(), projectConfigPath(process.cwd())]);
  } catch (e) {
    if (e instanceof ConfigError) die(e.message);
    throw e;
  }
}

function ago(ms: number): string {
  if (ms < 1000) return `${ms}ms ago`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${(ms / 3_600_000).toFixed(1)}h ago`;
}
function inMs(ms: number): string {
  if (ms <= 0) return "now";
  if (ms < 60_000) return `in ${(ms / 1000).toFixed(1)}s`;
  return `in ${Math.round(ms / 60_000)}m`;
}

interface Row {
  key: string;
  label: string;
  minIntervalMs: number | null;
  lastFinishedAt: number | null;
  nextAllowedInMs: number;
  inFlight: LastRecord["inFlight"];
  inFlightOwnerAlive: boolean | null;
  lastHour: number;
  totalCalls: number;
}

function statusRows(store: Store, config: Config): Row[] {
  const now = Date.now();
  const intervals = new Map<string, number>();
  for (const r of config.rules) intervals.set(ruleKey(r.name), r.minIntervalMs);
  const keys = new Set(store.listBuckets());
  for (const r of config.rules) if (!r.perHost) keys.add(ruleKey(r.name));
  const rows: Row[] = [];
  for (const key of [...keys].sort()) {
    const rec = store.readLast(key, key);
    let interval = intervals.get(key) ?? null;
    if (interval === null) {
      const m = /^r_([^_].*?)__/.exec(key);
      const rule = m ? config.rules.find((r) => ruleKey(r.name) === `r_${m[1]}`) : undefined;
      interval = rule ? rule.minIntervalMs : key.startsWith("h_") && config.defaultMinIntervalMs > 0 ? config.defaultMinIntervalMs : null;
    }
    const label = rec.label !== key ? rec.label : config.rules.find((r) => ruleKey(r.name) === key)?.name ?? key;
    const active = store.inFlightActive(rec.inFlight, config.inFlightHoldMs, now);
    const holdLeft = active && rec.inFlight ? rec.inFlight.since + config.inFlightHoldMs - now : 0;
    const wait = computeWaitMs({ lastFinishedAt: rec.lastFinishedAt, nowMs: now, minIntervalMs: interval ?? 0 });
    rows.push({
      key,
      label,
      minIntervalMs: interval,
      lastFinishedAt: rec.lastFinishedAt,
      nextAllowedInMs: active ? Math.max(wait, holdLeft + (interval ?? 0)) : wait,
      inFlight: active ? rec.inFlight : null,
      inFlightOwnerAlive: active && rec.inFlight ? (rec.inFlight.ownerPid > 1 ? pidAlive(rec.inFlight.ownerPid) : null) : null,
      lastHour: rec.recent.filter((t) => t > now - 3_600_000).length,
      totalCalls: rec.totalCalls ?? 0,
    });
  }
  return rows;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function cmdStatus(args: string[]): void {
  const { config, files } = loadCfg();
  const store = new Store(stateDir());
  const rows = statusRows(store, config);
  const tabs = store.readTabs();
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ stateDir: store.dir, configFiles: files, targets: rows, tabs }, null, 2)}\n`);
    return;
  }
  const now = Date.now();
  const lines: string[] = [];
  lines.push(`paceline ${VERSION}   state: ${store.dir}`);
  lines.push(`config: ${files.length ? files.join(" + ") : "(none found — nothing is paced; see paceline config)"}`);
  lines.push("");
  if (rows.length === 0) {
    lines.push("no targets yet.");
  } else {
    const w = Math.max(8, ...rows.map((r) => r.label.length)) + 2;
    lines.push(`${pad("TARGET", w)}${pad("INTERVAL", 10)}${pad("LAST CALL", 14)}${pad("NEXT ALLOWED", 14)}${pad("IN FLIGHT", 34)}LAST HOUR  TOTAL`);
    for (const r of rows) {
      const inflight = r.inFlight
        ? `${(r.inFlight.toolName ?? "?").replace("mcp__claude-in-chrome__", "chrome:")} ${ago(now - r.inFlight.since)}${r.inFlightOwnerAlive === false ? " (owner gone)" : ""}`
        : "—";
      lines.push(
        `${pad(r.label, w)}${pad(r.minIntervalMs === null ? "—" : `${r.minIntervalMs}ms`, 10)}${pad(r.lastFinishedAt ? ago(now - r.lastFinishedAt) : "never", 14)}${pad(r.inFlight ? `+${(r.minIntervalMs ?? 0) / 1000}s after it` : inMs(r.nextAllowedInMs), 14)}${pad(inflight, 34)}${pad(String(r.lastHour), 11)}${r.totalCalls}`,
      );
    }
  }
  const tabCount = Object.keys(tabs).length;
  lines.push("");
  lines.push(`browser tabs mapped: ${tabCount}${tabCount ? ` (${Object.entries(tabs).slice(0, 6).map(([id, t]) => `${id}→${t.host}`).join(", ")}${tabCount > 6 ? ", …" : ""})` : ""}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

function cmdReset(args: string[]): void {
  const store = new Store(stateDir());
  if (args.includes("--tabs")) {
    fs.rmSync(store.tabsFile, { force: true });
    process.stdout.write("forgot all browser tabs.\n");
    if (args.length === 1) return;
  }
  if (args.includes("--all")) {
    const keys = store.listBuckets();
    for (const k of keys) store.removeBucket(k);
    fs.rmSync(path.join(store.dir, "claims"), { recursive: true, force: true });
    process.stdout.write(`reset ${keys.length} target(s).\n`);
    return;
  }
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) die("reset needs a target, --all, or --tabs", 64);
  const { config } = loadCfg();
  const existing = store.listBuckets();
  const want = new Set<string>();
  const addRule = (name: string): void => {
    want.add(ruleKey(name));
    const prefix = `${ruleKey(name)}__`;
    for (const k of existing) if (k.startsWith(prefix)) want.add(k); // perHost buckets
  };
  for (const r of config.rules) {
    if (r.name === target) addRule(r.name);
    // `reset '*.myshopify.com'` names the rule by its glob; `reset a.myshopify.com` names a host it covers.
    if (ruleTargets(r).some((t) => t === target || hostMatches(t, target))) {
      addRule(r.name);
      want.add(hostKey(target, r.name));
    }
  }
  want.add(hostKey(target));
  if (existing.includes(target)) want.add(target);
  for (const k of existing) {
    if (store.readLast(k).label === target) want.add(k);
  }
  const hit = [...want].filter((k) => existing.includes(k));
  if (hit.length === 0) die(`no state for "${target}" (known: ${existing.join(", ") || "none"})`);
  for (const k of hit) store.removeBucket(k);
  process.stdout.write(`reset ${hit.join(", ")}\n`);
}

async function cmdRun(argv: string[]): Promise<void> {
  const sep = argv.indexOf("--");
  if (sep === -1 || sep === argv.length - 1) die("run needs `-- <cmd> [args]`", 64);
  const opts = argv.slice(0, sep);
  const cmd = argv.slice(sep + 1);
  const hosts = flags(opts, "--target").map((h) => h.toLowerCase());
  if (hosts.length === 0) die("run needs at least one --target <host>", 64);
  const interval = flag(opts, "--interval");
  const { config } = loadCfg();
  const store = new Store(stateDir(), { staleLockMs: config.staleLockMs });
  let buckets: Bucket[] = bucketsFor(config, hosts);
  if (interval !== undefined) {
    const ms = Number(interval);
    if (!Number.isFinite(ms) || ms < 0) die("--interval must be a non-negative number of ms");
    const covered = new Set(buckets.map((b) => b.key));
    for (const h of hosts) {
      const key = hostKey(h);
      if (![...covered].some((k) => k === key) && !config.rules.some((r) => ruleTargets(r).some((t) => hostMatches(t, h)))) {
        buckets.push({ key, label: h, minIntervalMs: ms });
      }
    }
    buckets = buckets.sort((a, b) => (a.key < b.key ? -1 : 1));
  }
  if (buckets.length === 0) {
    process.stderr.write(`paceline: no rule matches ${hosts.join(", ")} and no --interval given; running unpaced.\n`);
  }
  const toolUseId = `run-${process.pid}-${Date.now().toString(36)}`;
  const t0 = Date.now();
  const result = await pace(
    store,
    buckets,
    { toolUseId, sessionId: "paceline-run", toolName: `run:${path.basename(cmd[0]!)}`, ownerPid: process.pid },
    { deadlineMs: t0 + Math.max(config.maxWaitMs, 3_600_000), inFlightHoldMs: config.inFlightHoldMs },
  );
  if (result.denied) die(result.denied, 75);
  if (result.waitedMs >= config.notifyAfterMs) {
    process.stderr.write(`paceline: waited ${(result.waitedMs / 1000).toFixed(1)}s for ${buckets.map((b) => b.label).join(", ")}\n`);
  }
  const finish = async (code: number): Promise<never> => {
    await release(store, toolUseId);
    process.exit(code);
  };
  const start = (useShell: boolean): void => {
    const child = useShell
      ? spawn(cmd.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" "), { stdio: "inherit", shell: true })
      : spawn(cmd[0]!, cmd.slice(1), { stdio: "inherit" });
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(sig, () => {
        child.kill(sig);
      });
    }
    child.on("error", (e) => {
      const code = (e as NodeJS.ErrnoException).code;
      // On Windows, npm's `.cmd` shims and batch files only run through the shell.
      if (!useShell && process.platform === "win32" && (code === "EINVAL" || code === "ENOENT")) {
        start(true);
        return;
      }
      process.stderr.write(`paceline: cannot run ${cmd[0]}: ${e.message}\n`);
      void finish(127);
    });
    child.on("exit", (code, signal) => {
      void finish(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1));
    });
  };
  start(false);
}

interface CallResult {
  idx: number;
  preStart: number;
  preEnd: number;
  postEnd: number;
  stdout: string;
  exitCode: number | null;
}

function hookPath(): string {
  if (process.env.PACELINE_HOOK_PATH) return process.env.PACELINE_HOOK_PATH;
  return path.join(__dirname, "hook.js");
}

function runHook(mode: "pre" | "post", payload: unknown, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hookPath(), mode], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function cmdTest(args: string[]): Promise<void> {
  const interval = intFlag(args, "--interval", 2000);
  const calls = Math.max(1, intFlag(args, "--calls", 5));
  const parallel = Math.max(1, Math.min(calls, intFlag(args, "--parallel", calls)));
  const keep = args.includes("--keep");
  const hook = hookPath();
  if (!fs.existsSync(hook)) die(`hook not found at ${hook} (run npm run build, or set PACELINE_HOOK_PATH)`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "paceline-test-"));
  const cfgFile = path.join(tmp, "paceline.json");
  fs.writeFileSync(
    cfgFile,
    JSON.stringify({ rules: [{ name: "paceline-test", target: "paceline.test", minIntervalMs: interval }] }, null, 2),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PACELINE_STATE_DIR: path.join(tmp, "state"),
    PACELINE_CONFIG: cfgFile,
    PACELINE_NO_PROJECT_CONFIG: "1",
    PACELINE_DISABLED: "",
  };
  process.stdout.write(`paceline test: ${calls} call(s), minimum interval ${interval} ms, up to ${parallel} hook processes at once\n`);
  process.stdout.write(`state: ${env.PACELINE_STATE_DIR}\n\n`);

  const results: CallResult[] = [];
  const wall0 = Date.now();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < calls) {
      const idx = next++;
      const toolUseId = `test-${idx}`;
      const payload = {
        session_id: `test-session-${idx % 2}`,
        hook_event_name: "PreToolUse",
        tool_name: "WebFetch",
        tool_input: { url: `https://paceline.test/call/${idx}` },
        tool_use_id: toolUseId,
      };
      const preStart = Date.now();
      const pre = await runHook("pre", payload, env);
      const preEnd = Date.now();
      if (pre.code !== 0) die(`pre #${idx} exited ${pre.code}: ${pre.stderr}`);
      if (pre.stdout.includes('"deny"')) die(`pre #${idx} was denied: ${pre.stdout}`);
      const post = await runHook("post", { ...payload, hook_event_name: "PostToolUse", tool_response: { ok: true } }, env);
      const postEnd = Date.now();
      if (post.code !== 0) die(`post #${idx} exited ${post.code}: ${post.stderr}`);
      results.push({ idx, preStart, preEnd, postEnd, stdout: pre.stdout, exitCode: pre.code });
    }
  };
  await Promise.all(Array.from({ length: parallel }, () => worker()));
  const wall = Date.now() - wall0;

  results.sort((a, b) => a.preEnd - b.preEnd);
  for (const r of results) {
    const msg = (() => {
      try {
        return (JSON.parse(r.stdout) as { systemMessage?: string }).systemMessage ?? "";
      } catch {
        return r.stdout ? "(non-JSON stdout!)" : "";
      }
    })();
    process.stdout.write(
      `  call #${r.idx}  pre took ${pad(`${r.preEnd - r.preStart} ms`, 9)} released at +${pad(`${r.postEnd - wall0} ms`, 8)}${msg ? `  ${msg}` : ""}\n`,
    );
  }

  // The gap that matters is finish→start as the hooks themselves recorded it:
  // the k-th claim timestamp minus the (k-1)-th finish timestamp.
  const rec = new Store(env.PACELINE_STATE_DIR!).readLast(ruleKey("paceline-test"));
  const starts = [...(rec.recentStarts ?? [])].sort((a, b) => a - b);
  const finishes = [...rec.recent].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < Math.min(starts.length, finishes.length + 1); i++) gaps.push(starts[i]! - finishes[i - 1]!);
  // Observed from outside, including process start/exit overhead (informational).
  const observed: number[] = [];
  for (let i = 1; i < results.length; i++) observed.push(results[i]!.preEnd - results[i - 1]!.postEnd);
  const required = (calls - 1) * interval;
  const minGap = gaps.length ? Math.min(...gaps) : Infinity;
  const nonJson = results.filter((r) => r.stdout.trim() && !r.stdout.trim().startsWith("{"));

  process.stdout.write("\n");
  process.stdout.write(`  finish→start gaps recorded by the hooks (ms): ${gaps.join(", ") || "n/a"}   min ${Number.isFinite(minGap) ? minGap : "n/a"}   required ≥ ${interval}\n`);
  process.stdout.write(`  observed from outside, incl. process overhead:  ${observed.join(", ") || "n/a"}\n`);
  process.stdout.write(`  wall time ${(wall / 1000).toFixed(2)} s   required ≥ ${(required / 1000).toFixed(2)} s\n`);
  const ok = gaps.length === calls - 1 && minGap >= interval && wall >= required && finishes.length === calls && nonJson.length === 0;
  process.stdout.write(
    `\n${ok ? "PASS" : "FAIL"}: ${finishes.length}/${calls} calls finished, ${gaps.filter((g) => g >= interval).length}/${gaps.length} gaps ≥ ${interval} ms${finishes.length !== calls ? ` (expected ${calls} finishes)` : ""}${nonJson.length ? ", non-JSON stdout from a hook" : ""}\n`,
  );
  if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
  else process.stdout.write(`kept ${tmp}\n`);
  process.exit(ok ? 0 : 1);
}

function cmdConfig(): void {
  const { config, files } = loadCfg();
  process.stdout.write(`user config:    ${userConfigPath()}${fs.existsSync(userConfigPath()) ? "" : "  (missing)"}\n`);
  process.stdout.write(`project config: ${projectConfigPath(process.cwd())}${fs.existsSync(projectConfigPath(process.cwd())) ? "" : "  (missing)"}\n`);
  process.stdout.write(`merged from:    ${files.join(", ") || "(defaults only)"}\n\n`);
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}

function cmdLog(args: string[]): void {
  const n = intFlag(args, "-n", 50);
  const file = path.join(stateDir(), "paceline.log");
  if (!fs.existsSync(file)) die(`no log yet at ${file}`);
  const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  process.stdout.write(`${lines.slice(-n).join("\n")}\n`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "status":
      return cmdStatus(rest);
    case "reset":
      return cmdReset(rest);
    case "run":
      return cmdRun(rest);
    case "test":
      return cmdTest(rest);
    case "config":
      return cmdConfig();
    case "log":
      return cmdLog(rest);
    case "paths":
      process.stdout.write(`state:   ${stateDir()}\nuser:    ${userConfigPath()}\nproject: ${projectConfigPath(process.cwd())}\nhook:    ${hookPath()}\n`);
      return;
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;
    default:
      die(`unknown command "${cmd}"\n\n${HELP}`, 64);
  }
}

void main().catch((e) => {
  process.stderr.write(`paceline: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
