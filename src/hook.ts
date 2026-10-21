import path from "node:path";
import { ConfigError, DEFAULT_CONFIG, loadConfig, refuseFor, rulesForHost, type Config } from "./config.js";
import { logLine } from "./log.js";
import { allRuleBuckets, bucketsFor, pace, release, type Bucket } from "./pacer.js";
import { projectConfigPath, projectDir, stateDir, userConfigPath } from "./paths.js";
import { Store } from "./state.js";
import { CHROME_PREFIX, hostFromUrl, isLoopback, resolveTargets, tabIdOf, tabsFromResponse, unpaceableReason, type HookInput } from "./targets.js";

/** Tools whose results list the open tabs with their URLs. Only these may teach the tab → site map. */
const TAB_LISTING_TOOLS = new Set([`${CHROME_PREFIX}tabs_context_mcp`, `${CHROME_PREFIX}list_tabs`, `${CHROME_PREFIX}tabs_create_mcp`]);

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

/** Lock acquisition budget; overridable for tests. */
function lockTimeoutMs(): number {
  const v = Number(process.env.PACELINE_LOCK_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 30_000;
}

function toolUseIdFor(input: HookInput): string {
  if (typeof input.tool_use_id === "string" && input.tool_use_id) return input.tool_use_id;
  return `${typeof input.session_id === "string" ? input.session_id : "nosession"}:${typeof input.tool_name === "string" ? input.tool_name : "notool"}`;
}

function short(s: string | undefined, n = 60): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

async function handlePre(input: HookInput, state: string): Promise<void> {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  if (!toolName) return;
  const cwd = typeof input.cwd === "string" ? input.cwd : undefined;

  let config: Config;
  let configError: ConfigError | undefined;
  try {
    const proj = projectDir(cwd);
    config = loadConfig([userConfigPath(), proj ? projectConfigPath(proj) : undefined]).config;
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    configError = e;
    config = DEFAULT_CONFIG;
  }
  const store = new Store(state, { lockTimeoutMs: lockTimeoutMs(), staleLockMs: config.staleLockMs });

  const tabs = toolName.startsWith(CHROME_PREFIX) ? store.readTabs() : {};
  const resolved = resolveTargets(input, tabs, config.readOnlyTools);
  if (resolved.readOnly) return;

  if (configError) {
    // Fail closed only for calls that actually reach a network host.
    if (resolved.hosts.some((h) => !isLoopback(h)) || resolved.unknownTab !== undefined) {
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
    buckets = allRuleBuckets(config, store);
    notes.push(
      `paceline: tab ${resolved.unknownTab} has no known site yet, so this call was paced against all ${buckets.length} rule(s) (unknownTargetPolicy: pace-all). Navigate in the tab first, or set "unknownTargetPolicy": "ignore".`,
    );
  } else {
    buckets = bucketsFor(config, resolved.hosts);
    // `curl -L https://short.example/x` can 302 to a paced host the text never names. Treat a
    // redirect-following command aimed at an unpaced host like an unknown tab: pace it against
    // every rule unless the user opted out.
    if (resolved.followsRedirects && config.redirectPolicy === "pace-all" && config.rules.length > 0) {
      const unpaced = resolved.hosts.filter((h) => !isLoopback(h) && rulesForHost(config, h).length === 0);
      if (unpaced.length > 0) {
        const byKey = new Map(buckets.map((b) => [b.key, b] as const));
        for (const b of allRuleBuckets(config, store)) if (!byKey.has(b.key)) byKey.set(b.key, b);
        buckets = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        notes.push(
          `paceline: this command follows redirects and ${unpaced.join(", ")} matches no rule, so its final destination is unknown. It was paced against all ${config.rules.length} rule(s) (redirectPolicy: pace-all). Drop -L/--location, request the final host directly, or set "redirectPolicy": "ignore".`,
        );
      }
    }
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
    { deadlineMs: Date.now() + config.maxWaitMs, inFlightHoldMs: config.inFlightHoldMs, reclaimOnOwnerExit: config.reclaimOnOwnerExit },
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

async function handlePost(input: HookInput, state: string): Promise<void> {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const toolUseId = toolUseIdFor(input);
  const now = Date.now();
  const store = new Store(state, { lockTimeoutMs: lockTimeoutMs() });
  const released = await release(store, toolUseId, now);
  const event = input.hook_event_name ?? "PostToolUse";

  if (toolName.startsWith(CHROME_PREFIX) && event === "PostToolUse") {
    // Page content (get_page_text, read_page, find …) must never teach the tab map: a page that
    // mentions "id 42 … https://other.site" would re-home tab 42. Only a navigation we issued and
    // the extension's own tab listings are trusted.
    const entries: Record<string, { host: string; url?: string }> = {};
    const tabId = tabIdOf(input.tool_input);
    if (toolName === `${CHROME_PREFIX}navigate` && tabId !== undefined && input.tool_input && typeof input.tool_input === "object") {
      const url = (input.tool_input as Record<string, unknown>).url;
      const host = hostFromUrl(url);
      if (host) entries[tabId] = { host, url: String(url) };
      // "back" / "forward": the tab is now on a page we cannot name; forget it so the next action
      // is treated as an unknown tab (pace-all) rather than attributed to the old site.
      else if (typeof url === "string" && /^(back|forward)$/i.test(url.trim())) store.forgetTab(tabId);
    }
    if (TAB_LISTING_TOOLS.has(toolName)) {
      Object.assign(entries, tabsFromResponse(input.tool_response));
      // The extension's listing format is not documented; PACELINE_DEBUG_TABS=1 records what it
      // returned so a mismatch can be diagnosed from the log (`paceline log`).
      if (process.env.PACELINE_DEBUG_TABS && process.env.PACELINE_DEBUG_TABS !== "0") {
        logLine(state, `tabs ${toolName} parsed ${JSON.stringify(entries)} from ${JSON.stringify(input.tool_response).slice(0, 4000)}`);
      }
    }
    if (toolName === `${CHROME_PREFIX}tabs_close_mcp` && tabId !== undefined) store.forgetTab(tabId);
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
  try {
    if (mode === "pre") await handlePre(input, state);
    else await handlePost(input, state);
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
  () => {
    // Let stdout drain naturally (pipes are async on some platforms); the unref'd timer only fires if something hangs.
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 2_000).unref();
  },
  (e) => {
    process.stderr.write(`paceline: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(1); // onFailure: "block" turns this into a denial
  },
);
