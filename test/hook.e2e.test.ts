import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ruleKey, Store } from "../src/state.js";

let tmp: string;
let hook: string;
let env: NodeJS.ProcessEnv;

interface Out {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function run(mode: "pre" | "post", payload: unknown, extraEnv: NodeJS.ProcessEnv = {}): Promise<Out> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [hook, mode], { env: { ...env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }));
    child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

function decision(o: Out): string | undefined {
  if (!o.stdout.trim()) return undefined;
  const j = JSON.parse(o.stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
  return j.hookSpecificOutput?.permissionDecision;
}
function reason(o: Out): string {
  return (JSON.parse(o.stdout) as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason;
}

const SLOW = 20_000;

const fetchCall = (host: string, id: string, session = "s1") => ({
  session_id: session,
  hook_event_name: "PreToolUse",
  tool_name: "WebFetch",
  tool_input: { url: `https://${host}/${id}` },
  tool_use_id: id,
});

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "paceline-e2e-"));
  hook = path.join(tmp, "hook.js");
  await build({
    entryPoints: [path.join(__dirname, "..", "src", "hook.ts")],
    outfile: hook,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    logLevel: "silent",
  });
  fs.writeFileSync(
    path.join(tmp, "paceline.json"),
    JSON.stringify({
      notifyAfterMs: 100,
      rules: [
        { name: "gh", target: "api.github.com", minIntervalMs: 400 },
        { name: "social", target: "*.example.com", minIntervalMs: 300, maxPerHour: 2 },
      ],
    }),
  );
  env = {
    ...process.env,
    PACELINE_STATE_DIR: path.join(tmp, "state"),
    PACELINE_CONFIG: path.join(tmp, "paceline.json"),
    PACELINE_NO_PROJECT_CONFIG: "1",
    PACELINE_DISABLED: "",
  };
}, 30_000);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("hook end to end", () => {
  it("passes a local Bash command through quickly with no output", async () => {
    const o = await run("pre", { tool_name: "Bash", tool_input: { command: "ls -la" }, tool_use_id: "b1" });
    expect(o.code).toBe(0);
    expect(o.stdout).toBe("");
    expect(o.ms).toBeLessThan(3000); // generous for CI; locally ~45 ms
  }, SLOW);

  it("passes an unknown host through and a read-only chrome tool through", async () => {
    expect((await run("pre", fetchCall("nobody.invalid", "u1"))).stdout).toBe("");
    const ro = await run("pre", { tool_name: "mcp__claude-in-chrome__screenshot", tool_input: { tabId: 1 }, tool_use_id: "ro" });
    expect(ro.stdout).toBe("");
  }, SLOW);

  it("enforces a finish-to-start gap across processes and reports the wait", async () => {
    const a = await run("pre", fetchCall("api.github.com", "g1"));
    expect(a.code).toBe(0);
    expect(a.stdout).toBe("");
    const finished = Date.now();
    await run("post", { ...fetchCall("api.github.com", "g1"), hook_event_name: "PostToolUse", tool_response: { ok: true } });
    const b = await run("pre", fetchCall("api.github.com", "g2", "s2"));
    const started = Date.now();
    expect(b.code).toBe(0);
    expect(started - finished).toBeGreaterThanOrEqual(400);
    expect(JSON.parse(b.stdout).systemMessage).toMatch(/paceline: waited .* for gh/);
    const rec = new Store(env.PACELINE_STATE_DIR!).readLast(ruleKey("gh"));
    expect(rec.recentStarts?.[1]! - rec.recent[0]!).toBeGreaterThanOrEqual(400);
    await run("post", { ...fetchCall("api.github.com", "g2", "s2"), hook_event_name: "PostToolUse", tool_response: {} });
  }, SLOW);

  it("holds a second caller while the first is in flight", async () => {
    await new Promise((r) => setTimeout(r, 450));
    await run("pre", fetchCall("api.github.com", "h1"));
    const second = run("pre", fetchCall("api.github.com", "h2", "s3"));
    await new Promise((r) => setTimeout(r, 500));
    await run("post", { ...fetchCall("api.github.com", "h1"), hook_event_name: "PostToolUse", tool_response: {} });
    const o = await second;
    expect(o.code).toBe(0);
    expect(o.ms).toBeGreaterThanOrEqual(900); // 500 in flight + 400 interval
    await run("post", { ...fetchCall("api.github.com", "h2", "s3"), hook_event_name: "PostToolUse", tool_response: {} });
  }, SLOW);

  it("releases on PostToolUseFailure", async () => {
    await new Promise((r) => setTimeout(r, 450));
    await run("pre", fetchCall("api.github.com", "f1"));
    await run("post", { ...fetchCall("api.github.com", "f1"), hook_event_name: "PostToolUseFailure", error: "boom" });
    const rec = new Store(env.PACELINE_STATE_DIR!).readLast(ruleKey("gh"));
    expect(rec.inFlight).toBeNull();
  }, SLOW);

  it("learns tab → host from navigate and tab listings, never from page content", async () => {
    await run("post", {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "mcp__claude-in-chrome__navigate",
      tool_input: { url: "https://www.example.com/feed", tabId: 42 },
      tool_use_id: "nav",
      tool_response: [{ type: "text", text: "Navigation completed" }],
    });
    await run("post", {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "mcp__claude-in-chrome__tabs_context_mcp",
      tool_input: {},
      tool_use_id: "ctx",
      tool_response: [{ type: "text", text: "Open tabs:\n- tab 43: https://api.github.com/\n- tab 42: https://www.example.com/feed" }],
    });
    // Page content that happens to look like a tab line must not re-home tab 42.
    await run("post", {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "mcp__claude-in-chrome__get_page_text",
      tool_input: { tabId: 42 },
      tool_use_id: "txt",
      tool_response: [{ type: "text", text: "Order id 42 shipped, track at https://tracking.other.net/x" }],
    });
    await run("post", {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "mcp__claude-in-chrome__read_page",
      tool_input: { tabId: 42 },
      tool_use_id: "rp",
      tool_response: { elements: [{ id: 42, href: "https://cdn.somewhere.org/img.png" }] },
    });
    const tabs = new Store(env.PACELINE_STATE_DIR!).readTabs();
    expect(tabs["42"]?.host).toBe("www.example.com");
    expect(tabs["43"]?.host).toBe("api.github.com");

    const batch = await run("pre", { tool_name: "mcp__claude-in-chrome__browser_batch", tool_input: { tabId: 42, actions: [] }, tool_use_id: "bb" });
    expect(decision(batch)).toBe("deny");
    expect(reason(batch)).toMatch(/browser_batch/);

    const js = await run("pre", { tool_name: "mcp__claude-in-chrome__javascript_tool", tool_input: { tabId: 42, text: "fetch(a);fetch(b)" }, tool_use_id: "js" });
    expect(decision(js)).toBe("deny");

    const click = await run("pre", { tool_name: "mcp__claude-in-chrome__computer", tool_input: { tabId: 42, action: "left_click", coordinate: [1, 1] }, tool_use_id: "c1" });
    expect(click.code).toBe(0);
    expect(decision(click)).toBeUndefined();
    const rec = new Store(env.PACELINE_STATE_DIR!).readLast(ruleKey("social"));
    expect(rec.inFlight?.toolUseId).toBe("c1");
    await run("post", { tool_name: "mcp__claude-in-chrome__computer", tool_input: { tabId: 42, action: "left_click" }, tool_use_id: "c1", tool_response: {} });
  }, SLOW);

  it("paces an unknown tab against every rule and says so", async () => {
    const o = await run("pre", { tool_name: "mcp__claude-in-chrome__form_input", tool_input: { tabId: 999, ref: "x" }, tool_use_id: "u9" });
    expect(o.code).toBe(0);
    expect(JSON.parse(o.stdout).systemMessage).toMatch(/tab 999 .* all 2 rule/);
    await run("post", { tool_name: "mcp__claude-in-chrome__form_input", tool_input: { tabId: 999 }, tool_use_id: "u9", tool_response: {} });
  }, SLOW);

  it("honours unknownTargetPolicy: ignore", async () => {
    const cfg = path.join(tmp, "ignore.json");
    fs.writeFileSync(cfg, JSON.stringify({ unknownTargetPolicy: "ignore", rules: [{ name: "x", target: "x.test", minIntervalMs: 1000 }] }));
    const o = await run("pre", { tool_name: "mcp__claude-in-chrome__form_input", tool_input: { tabId: 5 }, tool_use_id: "ig" }, { PACELINE_CONFIG: cfg });
    expect(o.stdout).toBe("");
  }, SLOW);

  it("denies the third call in an hour when maxPerHour is 2", async () => {
    // "social" already has one finished call (c1) and one (u9) ⇒ cap reached.
    await new Promise((r) => setTimeout(r, 350));
    const o = await run("pre", fetchCall("www.example.com", "cap"));
    expect(decision(o)).toBe("deny");
    expect(reason(o)).toMatch(/hourly cap/);
    expect(new Store(env.PACELINE_STATE_DIR!).readLast(ruleKey("social")).inFlight).toBeNull();
  }, SLOW);

  it("applies an explicit refuse rule regardless of target", async () => {
    const cfg = path.join(tmp, "refuse.json");
    fs.writeFileSync(cfg, JSON.stringify({ refuse: [{ tool: "mcp__claude-in-chrome__browser_batch", reason: "nope" }] }));
    const o = await run("pre", { tool_name: "mcp__claude-in-chrome__browser_batch", tool_input: {}, tool_use_id: "r" }, { PACELINE_CONFIG: cfg });
    expect(decision(o)).toBe("deny");
    expect(reason(o)).toBe("nope");
  }, SLOW);

  it("fails closed on a broken config, but only for external calls", async () => {
    const cfg = path.join(tmp, "bad.json");
    fs.writeFileSync(cfg, "{ not json");
    const ext = await run("pre", fetchCall("api.github.com", "bad1"), { PACELINE_CONFIG: cfg });
    expect(decision(ext)).toBe("deny");
    expect(reason(ext)).toMatch(/config is invalid/);
    const local = await run("pre", { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "bad2" }, { PACELINE_CONFIG: cfg });
    expect(local.stdout).toBe("");
  }, SLOW);

  it("denies unparseable input and ignores empty input", async () => {
    const o = await run("pre", "not json");
    expect(decision(o)).toBe("deny");
    const e = await run("pre", "");
    expect(e.code).toBe(0);
    expect(e.stdout).toBe("");
  }, SLOW);

  it("passes everything when PACELINE_DISABLED is set", async () => {
    const o = await run("pre", { tool_name: "mcp__claude-in-chrome__browser_batch", tool_input: { tabId: 42 }, tool_use_id: "d" }, { PACELINE_DISABLED: "1" });
    expect(o.stdout).toBe("");
  }, SLOW);

  it("gives up with a denial when the wait would exceed maxWaitMs", async () => {
    const cfg = path.join(tmp, "short.json");
    fs.writeFileSync(cfg, JSON.stringify({ maxWaitMs: 200, rules: [{ name: "slow", target: "slow.test", minIntervalMs: 5000 }] }));
    await run("pre", fetchCall("slow.test", "w1"), { PACELINE_CONFIG: cfg });
    await run("post", { ...fetchCall("slow.test", "w1"), hook_event_name: "PostToolUse", tool_response: {} }, { PACELINE_CONFIG: cfg });
    const o = await run("pre", fetchCall("slow.test", "w2"), { PACELINE_CONFIG: cfg });
    expect(decision(o)).toBe("deny");
    expect(reason(o)).toMatch(/needs .* more before the next call/);
    expect(o.ms).toBeLessThan(2000);
  }, SLOW);

  it("ignores a non-string tool_name and a non-string cwd instead of denying", async () => {
    const a = await run("pre", { tool_name: 5, tool_input: { command: "ls" }, tool_use_id: "odd1" });
    expect(a.code).toBe(0);
    expect(a.stdout).toBe("");
    const b = await run("pre", { tool_name: "Bash", cwd: 5, tool_input: { command: "ls" }, tool_use_id: "odd2" }, { PACELINE_NO_PROJECT_CONFIG: "" });
    expect(b.stdout).toBe("");
  });

  it("does not leak a claimed bucket when a later bucket cannot be locked", async () => {
    const cfg = path.join(tmp, "two.json");
    fs.writeFileSync(cfg, JSON.stringify({ rules: [{ name: "a", target: "a.test", minIntervalMs: 1 }, { name: "b", target: "b.test", minIntervalMs: 1 }] }));
    const store = new Store(env.PACELINE_STATE_DIR!);
    const release = await store.acquireLock(ruleKey("b")); // a live lock held by this process
    const t0 = Date.now();
    const o = await run("pre", { tool_name: "Bash", tool_input: { command: "curl https://a.test https://b.test" }, tool_use_id: "leak" }, { PACELINE_CONFIG: cfg, PACELINE_LOCK_TIMEOUT_MS: "500" });
    release();
    expect(decision(o)).toBe("deny");
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(store.readLast(ruleKey("a")).inFlight).toBeNull();
  }, SLOW);

  it("writes an audit log", () => {
    const log = fs.readFileSync(path.join(env.PACELINE_STATE_DIR!, "paceline.log"), "utf8");
    expect(log).toMatch(/pre GO +WebFetch g2 waited \d+ms for gh/);
    expect(log).toMatch(/pre DENY mcp__claude-in-chrome__browser_batch/);
  }, SLOW);
});
