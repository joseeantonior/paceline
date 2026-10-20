import path from "node:path";
import { ConfigError, DEFAULT_CONFIG, loadConfig, refuseFor, type Config } from "./config.js";
import { logLine } from "./log.js";
import { allRuleBuckets, bucketsFor, pace, release, type Bucket } from "./pacer.js";
import { projectConfigPath, projectDir, stateDir, userConfigPath } from "./paths.js";
import { Store } from "./state.js";
import { CHROME_PREFIX, hostFromUrl, resolveTargets, tabIdOf, tabsFromResponse, unpaceableReason, type HookInput } from "./targets.js";

type Mode = "pre" | "post";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
    // A hook is always given stdin; guard against a TTY anyway.
    if (process.stdin.isTTY) resolve("");
  });
}

/** stdout must be exactly one JSON object or nothing. */
function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj));
}

function deny(reason: string, extra: Record<string, unknown> = {}): void {
  emit({
    ...extra,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

function fmtWait(ms: number): string {
  return ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

function toolUseIdFor(input: HookInput): string {
  if (typeof input.tool_use_id === "string" && input.tool_use_id) return input.tool_use_id;
  return `${input.session_id ?? "nosession"}:${input.tool_name ?? "notool"}`;
}

function short(s: string | undefined, n = 60): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

async function handlePre(input: HookInput, store: Store, state: string): Promise<void> {
  const toolName = input.tool_name;
  if (!toolName) return;

  let config: Config;
  let configError: ConfigError | undefined;
  try {
    config = loadConfig([userConfigPath(), (() => { const p = projectDir(input.cwd); return p ? projectConfigPath(p) : undefined; })()]).config;
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    configError = e;
    config = DEFAULT_CONFIG;
  }

  const tabs = toolName.startsWith(CHROME_PREFIX) ? store.readTabs() : {};
  const resolved = resolveTargets(input, tabs, config.readOnlyTools);
  if (resolved.readOnly) return;

  if (configError) {
    // Fail closed only for calls that actually reach a network host.
    if (resolved.hosts.length > 0 || resolved.unknownTab !== undefined) {
      logLine(state, `pre DENY ${toolName} config error: ${configError.message}`);
      deny(`paceline: your config is invalid, so external calls are blocked until it is fixed. ${configError.message}`);
    }
    return;
  }

  const refused = refuseFor(config, toolName);
  if (refused) {
    logLine(state, `pre DENY ${toolName} refuse rule ${refused.tool}`);
    deny(refused.reason ?? `paceline: ${toolName} is refused by rule "${refused.tool}".`);
    return;
  }

  let buckets: Bucket[];
  const notes: string[] = [];
  if (resolved.unknownTab !== undefined) {
    if (config.unknownTargetPolicy === "ignore" || config.rules.length === 0) {
      logLine(state, `pre PASS ${toolName} unknown tab ${resolved.unknownTab} (policy ${config.unknownTargetPolicy})`);
      return;
    }
    buckets = allRuleBuckets(config);
    notes.push(
      `paceline: tab ${resolved.unknownTab} has no known site yet, so this call was paced against all ${buckets.length} rule(s) (unknownTargetPolicy: pace-all). Navigate in the tab first, or set "unknownTargetPolicy": "ignore".`,
    );
  } else {
    buckets = bucketsFor(config, resolved.hosts);
  }
  if (buckets.length === 0) return;

  if (config.refuseUnpaceable) {
    const why = unpaceableReason(toolName, input.tool_input);
    if (why) {
      logLine(state, `pre DENY ${toolName} unpaceable: ${buckets.map((b) => b.label).join(", ")}`);
      deny(why);
      return;
    }
  }

  const toolUseId = toolUseIdFor(input);
  const result = await pace(
    store,
    buckets,
    {
      toolUseId,
      sessionId: input.session_id,
      toolName,
      agentId: input.agent_id,
      ownerPid: process.ppid,
    },
    { deadlineMs: Date.now() + config.maxWaitMs, inFlightHoldMs: config.inFlightHoldMs },
  );

  const labels = buckets.map((b) => b.label).join(", ");
  if (result.denied) {
    logLine(state, `pre DENY ${toolName} ${short(toolUseId, 40)} after ${result.waitedMs}ms: ${labels}`);
    deny(result.denied);
    return;
  }
  logLine(state, `pre GO   ${toolName} ${short(toolUseId, 40)} waited ${result.waitedMs}ms for ${labels}${input.agent_id ? ` agent=${input.agent_id}` : ""}`);
  if (result.waitedMs >= config.notifyAfterMs) {
    const parts = Object.entries(result.waits)
      .filter(([, ms]) => ms >= 50)
      .map(([label, ms]) => `${fmtWait(ms)} for ${label}`);
    notes.unshift(`paceline: waited ${parts.length ? parts.join(", ") : fmtWait(result.waitedMs)}`);
  }
  if (notes.length) {
    // systemMessage reaches the person; additionalContext reaches the model, so it knows why the call stalled.
    emit({
      systemMessage: notes.join("\n"),
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: notes.join("\n") },
    });
  }
}

async function handlePost(input: HookInput, store: Store, state: string): Promise<void> {
  const toolName = input.tool_name ?? "";
  const toolUseId = toolUseIdFor(input);
  const now = Date.now();
  const released = await release(store, toolUseId, now);
  const event = input.hook_event_name ?? "PostToolUse";

  if (toolName.startsWith(CHROME_PREFIX)) {
    const entries = tabsFromResponse(input.tool_response);
    const tabId = tabIdOf(input.tool_input);
    if (event === "PostToolUse" && tabId !== undefined && input.tool_input && typeof input.tool_input === "object") {
      const url = (input.tool_input as Record<string, unknown>).url;
      const host = hostFromUrl(url);
      if (host) entries[tabId] = { host, url: String(url) };
    }
    if (toolName === `${CHROME_PREFIX}tabs_close_mcp` && tabId !== undefined && event === "PostToolUse") {
      store.forgetTab(tabId);
    }
    if (Object.keys(entries).length > 0) store.updateTabs(entries, now);
  }
  if (released.length > 0 || event !== "PostToolUse") {
    logLine(state, `${event === "PostToolUse" ? "post" : event} ${toolName} ${short(toolUseId, 40)} released ${released.join(", ") || "(nothing)"}`);
  }
}

async function main(): Promise<void> {
  const mode = (process.argv[2] ?? "") as Mode;
  if (mode !== "pre" && mode !== "post") {
    process.stderr.write("usage: hook.js pre|post  (reads a Claude Code hook event on stdin)\n");
    process.exit(64);
  }
  if (process.env.PACELINE_DISABLED && process.env.PACELINE_DISABLED !== "0") return;

  const raw = await readStdin();
  if (!raw.trim()) return;
  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    if (mode === "pre") deny("paceline: could not parse the hook input as JSON.");
    return;
  }
  if (!input || typeof input !== "object") return;

  const state = stateDir();
  // staleLockMs comes from config, but the store is needed before config is loaded; default is fine for locks.
  const store = new Store(state, { lockTimeoutMs: 30_000 });
  try {
    if (mode === "pre") await handlePre(input, store, state);
    else await handlePost(input, store, state);
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    logLine(state, `${mode} ERROR ${input.tool_name ?? ""}: ${msg}`);
    if (mode === "pre") {
      // Fail closed: the hook exists to stop calls, so an internal error must not let one through.
      deny(`paceline: internal error, call blocked to stay safe (${msg}). See ${path.join(state, "paceline.log")}.`);
    }
  }
}

void main().then(
  () => process.exit(0),
  (e) => {
    process.stderr.write(`paceline: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(1); // onFailure: "block" turns this into a denial
  },
);
