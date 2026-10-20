import fs from "node:fs";
import path from "node:path";

/* ---------- pure functions ---------- */

export interface WaitArgs {
  lastFinishedAt: number | null | undefined;
  nowMs: number;
  minIntervalMs: number;
}

/** Milliseconds to wait before a new call may start. Finish-to-start gap. */
export function computeWaitMs({ lastFinishedAt, nowMs, minIntervalMs }: WaitArgs): number {
  if (lastFinishedAt === null || lastFinishedAt === undefined) return 0;
  if (!Number.isFinite(lastFinishedAt) || !Number.isFinite(nowMs) || !Number.isFinite(minIntervalMs)) return 0;
  if (minIntervalMs <= 0) return 0;
  return Math.max(0, Math.floor(lastFinishedAt + minIntervalMs - nowMs));
}

export const HOUR_MS = 3_600_000;

/** Wait until a rolling per-hour cap frees a slot. 0 when under the cap. */
export function computeCapWaitMs(recent: readonly number[], maxPerHour: number | undefined, nowMs: number): number {
  if (!maxPerHour || maxPerHour < 1) return 0;
  const window = recent.filter((t) => Number.isFinite(t) && t > nowMs - HOUR_MS && t <= nowMs).sort((a, b) => a - b);
  if (window.length < maxPerHour) return 0;
  // The slot frees when the (length - maxPerHour + 1)-th oldest call leaves the window.
  const idx = window.length - maxPerHour;
  const frees = (window[idx] as number) + HOUR_MS;
  return Math.max(0, Math.ceil(frees - nowMs));
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

/* ---------- on-disk records ---------- */

export interface InFlight {
  since: number;
  /** pid of the hook process that claimed (short-lived; informational). */
  pid: number;
  /** pid of the process that spawned the hook — the Claude Code session. Dead ⇒ reclaim. */
  ownerPid: number;
  sessionId?: string;
  toolUseId?: string;
  toolName?: string;
  agentId?: string;
}

export interface LastRecord {
  label: string;
  lastFinishedAt: number | null;
  inFlight: InFlight | null;
  /** Finish timestamps for the last 24 h, oldest first. */
  recent: number[];
  /** Claim (start) timestamps for the last 24 h, oldest first. */
  recentStarts?: number[];
  totalCalls?: number;
}

export interface Claim {
  toolUseId: string;
  sessionId?: string;
  toolName?: string;
  agentId?: string;
  /** Bucket keys claimed by this call. */
  buckets: string[];
  since: number;
}

export interface TabEntry {
  host: string;
  url?: string;
  updatedAt: number;
}
export type TabsMap = Record<string, TabEntry>;

export class LockTimeout extends Error {
  constructor(public readonly lockDir: string) {
    super(`timed out acquiring lock ${lockDir}`);
    this.name = "LockTimeout";
  }
}

const RECENT_KEEP_MS = 24 * HOUR_MS;
const TABS_KEEP_MS = 7 * 24 * HOUR_MS;

export function sanitizeKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, "_").slice(0, 120);
}

/** Bucket key for a rule-scoped throttle. */
export function ruleKey(ruleName: string): string {
  return `r_${sanitizeKey(ruleName)}`;
}
/** Bucket key for a host-scoped throttle (perHost rules and defaultMinIntervalMs). */
export function hostKey(host: string, ruleName?: string): string {
  return ruleName ? `r_${sanitizeKey(ruleName)}__${sanitizeKey(host)}` : `h_${sanitizeKey(host)}`;
}

function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows can refuse to rename over an open file; fall back to a plain write.
    try {
      fs.writeFileSync(file, JSON.stringify(data));
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
    if ((e as NodeJS.ErrnoException).code !== "EPERM" && (e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    const text = fs.readFileSync(file, "utf8");
    if (!text.trim()) return undefined;
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export interface StoreOptions {
  staleLockMs?: number;
  lockTimeoutMs?: number;
}

/**
 * Cross-process state under one directory:
 *
 *   <dir>/targets/<key>/lock/owner.json   mkdir lock around read-modify-write
 *   <dir>/targets/<key>/last.json         LastRecord
 *   <dir>/claims/<toolUseId>.json         which buckets a call holds, for `post`
 *   <dir>/tabs.json                       tabId → host, for browser clicks
 */
export class Store {
  readonly dir: string;
  readonly staleLockMs: number;
  readonly lockTimeoutMs: number;

  constructor(dir: string, opts: StoreOptions = {}) {
    this.dir = dir;
    this.staleLockMs = opts.staleLockMs ?? 15 * 60_000;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 60_000;
  }

  get targetsDir(): string {
    return path.join(this.dir, "targets");
  }
  bucketDir(key: string): string {
    return path.join(this.targetsDir, key);
  }
  lockDir(key: string): string {
    return path.join(this.bucketDir(key), "lock");
  }
  lastFile(key: string): string {
    return path.join(this.bucketDir(key), "last.json");
  }
  claimFile(toolUseId: string): string {
    return path.join(this.dir, "claims", `${sanitizeKey(toolUseId)}.json`);
  }
  get tabsFile(): string {
    return path.join(this.dir, "tabs.json");
  }

  listBuckets(): string[] {
    try {
      return fs
        .readdirSync(this.targetsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      return [];
    }
  }

  /* ----- lock ----- */

  /** Returns true if the lock was removed (dead owner or too old). */
  private reclaimIfStale(lockDir: string): boolean {
    const owner = readJson<{ pid?: number; since?: number }>(path.join(lockDir, "owner.json"));
    let stale = false;
    if (owner === undefined) {
      // Half-created lock: give the creator a moment, then treat as stale.
      try {
        const st = fs.statSync(lockDir);
        stale = Date.now() - st.mtimeMs > 2_000;
      } catch {
        return true; // vanished
      }
    } else {
      const age = Date.now() - (owner.since ?? 0);
      stale = age > this.staleLockMs || (typeof owner.pid === "number" && !pidAlive(owner.pid));
    }
    if (!stale) return false;
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  async acquireLock(key: string): Promise<() => void> {
    const lockDir = this.lockDir(key);
    fs.mkdirSync(this.bucketDir(key), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    let backoff = 15;
    for (;;) {
      try {
        fs.mkdirSync(lockDir);
        fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, since: Date.now() }));
        return () => {
          try {
            fs.rmSync(lockDir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (this.reclaimIfStale(lockDir)) continue;
        if (Date.now() > deadline) throw new LockTimeout(lockDir);
        await sleep(backoff + Math.floor(Math.random() * 10));
        backoff = Math.min(backoff * 2, 100);
      }
    }
  }

  async withLock<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    const release = await this.acquireLock(key);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /* ----- last.json ----- */

  readLast(key: string, label = key): LastRecord {
    const rec = readJson<Partial<LastRecord>>(this.lastFile(key));
    return {
      label: typeof rec?.label === "string" ? rec.label : label,
      lastFinishedAt: typeof rec?.lastFinishedAt === "number" ? rec.lastFinishedAt : null,
      inFlight: rec?.inFlight && typeof rec.inFlight === "object" ? (rec.inFlight as InFlight) : null,
      recent: Array.isArray(rec?.recent) ? rec.recent.filter((n): n is number => typeof n === "number") : [],
      recentStarts: Array.isArray(rec?.recentStarts) ? rec.recentStarts.filter((n): n is number => typeof n === "number") : [],
      totalCalls: typeof rec?.totalCalls === "number" ? rec.totalCalls : 0,
    };
  }

  writeLast(key: string, rec: LastRecord): void {
    fs.mkdirSync(this.bucketDir(key), { recursive: true });
    writeAtomic(this.lastFile(key), rec);
  }

  /** Remove a bucket entirely (`paceline reset`). */
  removeBucket(key: string): void {
    fs.rmSync(this.bucketDir(key), { recursive: true, force: true });
  }

  /** True if the in-flight hold should still block others. */
  inFlightActive(inFlight: InFlight | null, holdMs: number, now = Date.now()): boolean {
    if (!inFlight) return false;
    if (now - inFlight.since >= holdMs) return false;
    if (inFlight.ownerPid > 1 && !pidAlive(inFlight.ownerPid)) return false;
    return true;
  }

  /** Mark a bucket finished: finish-time stamp, clear the matching in-flight hold. */
  finish(key: string, toolUseId: string | undefined, now = Date.now()): LastRecord {
    const rec = this.readLast(key);
    if (!rec.inFlight || toolUseId === undefined || rec.inFlight.toolUseId === toolUseId) {
      rec.inFlight = null;
    }
    rec.lastFinishedAt = Math.max(rec.lastFinishedAt ?? 0, now);
    rec.recent = [...rec.recent.filter((t) => t > now - RECENT_KEEP_MS), now];
    rec.recentStarts = (rec.recentStarts ?? []).filter((t) => t > now - RECENT_KEEP_MS);
    rec.totalCalls = (rec.totalCalls ?? 0) + 1;
    this.writeLast(key, rec);
    return rec;
  }

  /** Drop an in-flight hold without stamping a finish (deadline abort). */
  abandon(key: string, toolUseId: string): void {
    const rec = this.readLast(key);
    if (rec.inFlight && rec.inFlight.toolUseId === toolUseId) {
      rec.inFlight = null;
      this.writeLast(key, rec);
    }
  }

  /* ----- claims ----- */

  writeClaim(claim: Claim): void {
    const file = this.claimFile(claim.toolUseId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, claim);
  }

  takeClaim(toolUseId: string): Claim | undefined {
    const file = this.claimFile(toolUseId);
    const claim = readJson<Claim>(file);
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
    return claim && Array.isArray(claim.buckets) ? claim : undefined;
  }

  /** Buckets whose in-flight record names this tool use (fallback when no claim file). */
  bucketsInFlightFor(toolUseId: string): string[] {
    return this.listBuckets().filter((k) => this.readLast(k).inFlight?.toolUseId === toolUseId);
  }

  /* ----- tabs ----- */

  readTabs(): TabsMap {
    const tabs = readJson<TabsMap>(this.tabsFile);
    return tabs && typeof tabs === "object" ? tabs : {};
  }

  updateTabs(entries: Record<string, { host: string; url?: string }>, now = Date.now()): TabsMap {
    const tabs = this.readTabs();
    for (const [id, e] of Object.entries(entries)) {
      if (!e.host) continue;
      tabs[String(id)] = { host: e.host, url: e.url, updatedAt: now };
    }
    for (const [id, e] of Object.entries(tabs)) {
      if (!e || typeof e.updatedAt !== "number" || e.updatedAt < now - TABS_KEEP_MS) delete tabs[id];
    }
    fs.mkdirSync(this.dir, { recursive: true });
    writeAtomic(this.tabsFile, tabs);
    return tabs;
  }

  forgetTab(id: string): void {
    const tabs = this.readTabs();
    if (id in tabs) {
      delete tabs[id];
      writeAtomic(this.tabsFile, tabs);
    }
  }
}
