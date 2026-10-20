import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeCapWaitMs, computeWaitMs, hostKey, ruleKey, sanitizeKey, Store } from "../src/state.js";

describe("computeWaitMs", () => {
  it("is 0 with no previous call", () => {
    expect(computeWaitMs({ lastFinishedAt: null, nowMs: 1000, minIntervalMs: 500 })).toBe(0);
    expect(computeWaitMs({ lastFinishedAt: undefined, nowMs: 1000, minIntervalMs: 500 })).toBe(0);
  });
  it("is the remaining part of the interval", () => {
    expect(computeWaitMs({ lastFinishedAt: 1000, nowMs: 1200, minIntervalMs: 1000 })).toBe(800);
    expect(computeWaitMs({ lastFinishedAt: 1000, nowMs: 1000, minIntervalMs: 1000 })).toBe(1000);
  });
  it("never goes negative", () => {
    expect(computeWaitMs({ lastFinishedAt: 1000, nowMs: 5000, minIntervalMs: 1000 })).toBe(0);
    expect(computeWaitMs({ lastFinishedAt: 1000, nowMs: 2000, minIntervalMs: 1000 })).toBe(0);
  });
  it("is 0 for a zero or negative interval", () => {
    expect(computeWaitMs({ lastFinishedAt: 1000, nowMs: 1000, minIntervalMs: 0 })).toBe(0);
    expect(computeWaitMs({ lastFinishedAt: 1000, nowMs: 1000, minIntervalMs: -5 })).toBe(0);
  });
  it("tolerates a clock that went backwards", () => {
    expect(computeWaitMs({ lastFinishedAt: 10_000, nowMs: 5_000, minIntervalMs: 1000 })).toBe(6000);
  });
  it("ignores garbage", () => {
    expect(computeWaitMs({ lastFinishedAt: NaN, nowMs: 1, minIntervalMs: 1 })).toBe(0);
    expect(computeWaitMs({ lastFinishedAt: 1, nowMs: Infinity, minIntervalMs: 1 })).toBe(0);
  });
  it("floors fractional waits", () => {
    expect(computeWaitMs({ lastFinishedAt: 1000.7, nowMs: 1000, minIntervalMs: 10 })).toBe(10);
  });
});

describe("computeCapWaitMs", () => {
  const H = 3_600_000;
  it("is 0 without a cap or under the cap", () => {
    expect(computeCapWaitMs([1, 2, 3], undefined, 10)).toBe(0);
    expect(computeCapWaitMs([H - 10, H - 5], 3, H)).toBe(0);
  });
  it("waits until the oldest in-window call ages out", () => {
    const now = 2 * H;
    const recent = [now - 3000, now - 2000, now - 1000];
    expect(computeCapWaitMs(recent, 3, now)).toBe(H - 3000);
    expect(computeCapWaitMs(recent, 2, now)).toBe(H - 2000);
    expect(computeCapWaitMs(recent, 1, now)).toBe(H - 1000);
  });
  it("ignores calls older than an hour", () => {
    const now = 2 * H;
    expect(computeCapWaitMs([now - H - 1, now - 10], 1, now)).toBe(H - 10);
    expect(computeCapWaitMs([now - H - 1, now - H - 2], 1, now)).toBe(0);
  });
});

describe("keys", () => {
  it("sanitizes", () => {
    expect(sanitizeKey("Api.GitHub.com")).toBe("api.github.com");
    expect(sanitizeKey("a b/c:d")).toBe("a_b_c_d");
    expect(ruleKey("social")).toBe("r_social");
    expect(hostKey("x.myshopify.com")).toBe("h_x.myshopify.com");
    expect(hostKey("x.myshopify.com", "shops")).toBe("r_shops__x.myshopify.com");
  });
});

describe("Store", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "paceline-state-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reads a default record and round-trips writes", () => {
    const s = new Store(dir);
    expect(s.readLast("r_x", "x")).toEqual({ label: "x", lastFinishedAt: null, inFlight: null, recent: [], recentStarts: [], totalCalls: 0 });
    s.writeLast("r_x", { label: "x", lastFinishedAt: 5, inFlight: null, recent: [5], totalCalls: 1 });
    expect(s.readLast("r_x").lastFinishedAt).toBe(5);
    expect(fs.readdirSync(s.bucketDir("r_x")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("acquires and releases the mkdir lock", async () => {
    const s = new Store(dir);
    const release = await s.acquireLock("r_x");
    expect(fs.existsSync(s.lockDir("r_x"))).toBe(true);
    const owner = JSON.parse(fs.readFileSync(path.join(s.lockDir("r_x"), "owner.json"), "utf8"));
    expect(owner.pid).toBe(process.pid);
    release();
    expect(fs.existsSync(s.lockDir("r_x"))).toBe(false);
  });

  it("serializes concurrent withLock calls in one process", async () => {
    const s = new Store(dir);
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        s.withLock("r_x", async () => {
          inside++;
          maxInside = Math.max(maxInside, inside);
          await new Promise((r) => setTimeout(r, 10));
          inside--;
        }),
      ),
    );
    expect(maxInside).toBe(1);
  });

  it("reclaims a lock whose owner pid is dead", async () => {
    const s = new Store(dir, { lockTimeoutMs: 2000 });
    fs.mkdirSync(s.lockDir("r_x"), { recursive: true });
    // pid 2^22-1 is above the default Linux pid_max and never alive.
    fs.writeFileSync(path.join(s.lockDir("r_x"), "owner.json"), JSON.stringify({ pid: 4194303, since: Date.now() }));
    const t = Date.now();
    const release = await s.acquireLock("r_x");
    expect(Date.now() - t).toBeLessThan(1500);
    release();
  });

  it("reclaims a lock older than staleLockMs even if the owner is alive", async () => {
    const s = new Store(dir, { staleLockMs: 100, lockTimeoutMs: 2000 });
    fs.mkdirSync(s.lockDir("r_x"), { recursive: true });
    fs.writeFileSync(path.join(s.lockDir("r_x"), "owner.json"), JSON.stringify({ pid: process.pid, since: Date.now() - 1000 }));
    const release = await s.acquireLock("r_x");
    release();
  });

  it("times out on a live lock", async () => {
    const s = new Store(dir, { lockTimeoutMs: 150 });
    fs.mkdirSync(s.lockDir("r_x"), { recursive: true });
    fs.writeFileSync(path.join(s.lockDir("r_x"), "owner.json"), JSON.stringify({ pid: process.pid, since: Date.now() }));
    await expect(s.acquireLock("r_x")).rejects.toThrow(/timed out/);
  });

  it("finish stamps and clears the matching in-flight hold only", () => {
    const s = new Store(dir);
    s.writeLast("r_x", {
      label: "x",
      lastFinishedAt: null,
      inFlight: { since: 1, pid: 1, ownerPid: 1, toolUseId: "A" },
      recent: [],
    });
    s.finish("r_x", "B", 1000);
    expect(s.readLast("r_x").inFlight?.toolUseId).toBe("A");
    expect(s.readLast("r_x").lastFinishedAt).toBe(1000);
    s.finish("r_x", "A", 2000);
    expect(s.readLast("r_x").inFlight).toBeNull();
    expect(s.readLast("r_x").recent).toEqual([1000, 2000]);
    expect(s.readLast("r_x").totalCalls).toBe(2);
  });

  it("prunes recent entries older than 24h", () => {
    const s = new Store(dir);
    const now = 100 * 3_600_000;
    s.writeLast("r_x", { label: "x", lastFinishedAt: 1, inFlight: null, recent: [now - 25 * 3_600_000, now - 1000] });
    s.finish("r_x", undefined, now);
    expect(s.readLast("r_x").recent).toEqual([now - 1000, now]);
  });

  it("inFlightActive respects hold, and a dead owner", () => {
    const s = new Store(dir);
    expect(s.inFlightActive(null, 1000)).toBe(false);
    expect(s.inFlightActive({ since: 0, pid: 1, ownerPid: 1 }, 1000, 500)).toBe(true);
    expect(s.inFlightActive({ since: 0, pid: 1, ownerPid: 1 }, 1000, 1000)).toBe(false);
    expect(s.inFlightActive({ since: 0, pid: 1, ownerPid: 4194303 }, 1000, 500)).toBe(false);
    expect(s.inFlightActive({ since: 0, pid: 1, ownerPid: process.pid }, 1000, 500)).toBe(true);
  });

  it("claims round-trip and are consumed once", () => {
    const s = new Store(dir);
    s.writeClaim({ toolUseId: "toolu_1", buckets: ["r_a", "r_b"], since: 1 });
    expect(s.takeClaim("toolu_1")?.buckets).toEqual(["r_a", "r_b"]);
    expect(s.takeClaim("toolu_1")).toBeUndefined();
  });

  it("keeps claim file names case-sensitive and prunes stale claims", () => {
    const s = new Store(dir);
    s.writeClaim({ toolUseId: "toolu_ABC", buckets: ["r_a"], since: 1 });
    s.writeClaim({ toolUseId: "toolu_abc", buckets: ["r_b"], since: 1 });
    expect(s.takeClaim("toolu_ABC")?.buckets).toEqual(["r_a"]);
    expect(s.takeClaim("toolu_abc")?.buckets).toEqual(["r_b"]);
    s.writeClaim({ toolUseId: "old", buckets: ["r_a"], since: 1 });
    const old = s.claimFile("old");
    fs.utimesSync(old, new Date(Date.now() - 48 * 3_600_000), new Date(Date.now() - 48 * 3_600_000));
    s.writeClaim({ toolUseId: "fresh", buckets: ["r_a"], since: 1 });
    expect(s.pruneClaims()).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(s.takeClaim("fresh")).toBeDefined();
  });

  it("falls back to scanning in-flight records", () => {
    const s = new Store(dir);
    s.writeLast("r_a", { label: "a", lastFinishedAt: null, inFlight: { since: 1, pid: 1, ownerPid: 1, toolUseId: "T" }, recent: [] });
    s.writeLast("r_b", { label: "b", lastFinishedAt: null, inFlight: null, recent: [] });
    expect(s.bucketsInFlightFor("T")).toEqual(["r_a"]);
  });

  it("tabs map updates, forgets and prunes", () => {
    const s = new Store(dir);
    s.updateTabs({ "12": { host: "a.com", url: "https://a.com/x" } }, 1000);
    s.updateTabs({ "13": { host: "b.com" } }, 2000);
    expect(Object.keys(s.readTabs()).sort()).toEqual(["12", "13"]);
    s.forgetTab("12");
    expect(Object.keys(s.readTabs())).toEqual(["13"]);
    s.updateTabs({ "14": { host: "c.com" } }, 2000 + 8 * 24 * 3_600_000);
    expect(Object.keys(s.readTabs())).toEqual(["14"]);
  });
});
