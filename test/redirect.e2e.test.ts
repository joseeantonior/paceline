import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ruleKey, Store } from "../src/state.js";

/**
 * Two-host redirect fixture. Server A stands in for an unpaced URL shortener and
 * 302-redirects to server B, which stands in for a paced API host. A command like
 * `curl -L http://short.example/...` names only A, but the request lands on B.
 */

let tmp: string;
let hook: string;
let env: NodeJS.ProcessEnv;
let a: http.Server;
let b: http.Server;
let portA = 0;
let portB = 0;
const hitsOnB: string[] = [];

function runHook(mode: "pre" | "post", payload: unknown, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hook, mode], { env: { ...env, ...extraEnv }, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(payload));
  });
}

/** Real curl, async with a hard cap; `missing` when curl is not installed. */
function runCurl(args: string[]): Promise<{ status: number | null; stdout: string; missing?: boolean }> {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn("curl", args, { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, missing: (e as NodeJS.ErrnoException).code === "ENOENT" });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout });
    });
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

const bash = (command: string, id: string) => ({ session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: id });

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "paceline-redirect-"));
  hook = path.join(tmp, "hook.js");
  await build({ entryPoints: [path.join(__dirname, "..", "src", "hook.ts")], outfile: hook, bundle: true, platform: "node", format: "cjs", target: "node20", logLevel: "silent" });
  b = http.createServer((req, res) => {
    hitsOnB.push(`${req.method} ${req.url}`);
    res.end("payload from the paced host\n");
  });
  portB = await listen(b);
  a = http.createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${portB}/api/follow` });
    res.end();
  });
  portA = await listen(a);
  fs.writeFileSync(path.join(tmp, "paceline.json"), JSON.stringify({ notifyAfterMs: 0, rules: [{ name: "github", target: "api.github.com", minIntervalMs: 200 }] }));
  env = { ...process.env, PACELINE_STATE_DIR: path.join(tmp, "state"), PACELINE_CONFIG: path.join(tmp, "paceline.json"), PACELINE_NO_PROJECT_CONFIG: "1", PACELINE_DISABLED: "" };
}, 30_000);

afterAll(async () => {
  a.closeAllConnections();
  b.closeAllConnections();
  await new Promise((r) => a.close(r));
  await new Promise((r) => b.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("redirects", () => {
  // The command text only ever names short.example (resolved to A). The redirect target is B.
  const url = () => `http://short.example:${portA}/t/abc`;
  const resolveFlag = () => `--resolve short.example:${portA}:127.0.0.1`;

  it("the leak is real: curl -L reaches a host the command text never names", async (ctx) => {
    const r = await runCurl(["-sL", ...resolveFlag().split(" "), url()]);
    if (r.missing) return ctx.skip();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("payload from the paced host");
    expect(hitsOnB).toEqual(["GET /api/follow"]);
  }, 20_000);

  it("a plain curl to an unpaced host still passes with no bucket", async () => {
    const o = await runHook("pre", bash(`curl -s ${resolveFlag()} ${url()}`, "plain"));
    expect(o.code).toBe(0);
    expect(o.stdout).toBe("");
    expect(new Store(env.PACELINE_STATE_DIR!).listBuckets()).toEqual([]);
  });

  it("curl -L to an unpaced host is paced against every rule and says why", async () => {
    const o = await runHook("pre", bash(`curl -sL ${resolveFlag()} ${url()}`, "follow"));
    expect(o.code).toBe(0);
    const out = JSON.parse(o.stdout) as { systemMessage: string };
    expect(out.systemMessage).toMatch(/follows redirects and short\.example matches no rule/);
    expect(out.systemMessage).toMatch(/redirectPolicy: pace-all/);
    const rec = new Store(env.PACELINE_STATE_DIR!).readLast(ruleKey("github"));
    expect(rec.inFlight?.toolUseId).toBe("follow");
    await runHook("post", { ...bash(`curl -sL ${url()}`, "follow"), hook_event_name: "PostToolUse", tool_response: {} });
    expect(new Store(env.PACELINE_STATE_DIR!).readLast(ruleKey("github")).inFlight).toBeNull();
  });

  it("wget follows by default and is paced; --max-redirect=0 is not", async () => {
    const paced = await runHook("pre", bash(`wget -q ${url()}`, "wget1"));
    expect(JSON.parse(paced.stdout).systemMessage).toMatch(/follows redirects/);
    await runHook("post", { ...bash(`wget -q ${url()}`, "wget1"), hook_event_name: "PostToolUse", tool_response: {} });
    const plain = await runHook("pre", bash(`wget -q --max-redirect=0 ${url()}`, "wget2"));
    expect(plain.stdout).toBe("");
  });

  it("curl -L straight to a paced host is paced once, with no redirect note", async () => {
    await new Promise((r) => setTimeout(r, 250));
    const o = await runHook("pre", bash("curl -fsSL https://api.github.com/repos/x/y", "direct"));
    expect(o.stdout === "" || !JSON.parse(o.stdout).systemMessage?.includes("follows redirects")).toBe(true);
    expect(new Store(env.PACELINE_STATE_DIR!).readLast(ruleKey("github")).inFlight?.toolUseId).toBe("direct");
    await runHook("post", { ...bash("curl -fsSL https://api.github.com/repos/x/y", "direct"), hook_event_name: "PostToolUse", tool_response: {} });
  });

  it('redirectPolicy: "ignore" restores pass-through', async () => {
    const cfg = path.join(tmp, "ignore.json");
    fs.writeFileSync(cfg, JSON.stringify({ redirectPolicy: "ignore", rules: [{ name: "github", target: "api.github.com", minIntervalMs: 200 }] }));
    const o = await runHook("pre", bash(`curl -sL ${url()}`, "ign"), { PACELINE_CONFIG: cfg });
    expect(o.stdout).toBe("");
  });

  it("with no rules configured nothing changes", async () => {
    const cfg = path.join(tmp, "none.json");
    fs.writeFileSync(cfg, JSON.stringify({}));
    const o = await runHook("pre", bash(`curl -sL ${url()}`, "none"), { PACELINE_CONFIG: cfg });
    expect(o.stdout).toBe("");
  });
});
