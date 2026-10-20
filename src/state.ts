import crypto from "node:crypto";
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
  // A stamp in the future means the clock stepped backwards; never wait longer than one interval.
  const last = Math.min(lastFinishedAt, nowMs);
  return Math.max(0, Math.floor(last + minIntervalMs - nowMs));
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

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  // Windows can refuse to rename over a file another process has open for a moment; retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < 20) {
        sleepSync(5);
        continue;
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw e;
    }
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
  get claimsDir(): string {
    return path.join(this.dir, "claims");
  }
  claimFile(toolUseId: string): string {
    // Tool use ids are case-sensitive; a short hash keeps two ids apart even on case-insensitive filesystems.
    const safe = toolUseId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 100);
    const hash = crypto.createHash("sha1").update(toolUseId).digest("hex").slice(0, 10);
    return path.join(this.claimsDir, `${safe}-${hash}.json`);
  }

  /** Delete claim files whose call never reported back (older than `maxAgeMs`). */
  pruneClaims(maxAgeMs = 24 * HOUR_MS, now = Date.now()): number {
    let removed = 0;
    let names: string[];
    try {
      names = fs.readdirSync(this.claimsDir);
    } catch {
      return 0;
    }
    for (const name of names) {
      const file = path.join(this.claimsDir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > maxAgeMs) {
          fs.unlinkSync(file);
          removed++;
        }
      } catch {
        /* ignore */
      }
    }
    return removed;
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

  private readOwner(lockDir: string): { pid?: number; since?: number } | undefined {
    return readJson<{ pid?: number; since?: number }>(path.join(lockDir, "owner.json"));
  }

  private isStale(lockDir: string, owner: { pid?: number; since?: number } | undefined): boolean {
    if (owner === undefined) {
      // Half-created lock: give the creator a moment, then treat as stale.
      try {
        return Date.now() - fs.statSync(lockDir).mtimeMs > 2_000;
      } catch {
        return true; // vanished; the caller retries mkdir
      }
    }
    const age = Date.now() - (owner.since ?? 0);
    return age > this.staleLockMs || (typeof owner.pid === "number" && !pidAlive(owner.pid));
  }

  /**
   * Remove a stale lock so the caller can retry mkdir. Reclaim is done by
   * renaming the lock directory to a unique name: rename is atomic, so of
   * several contenders exactly one wins, and the winner then checks that what
   * it grabbed is still the stale lock it saw (not a fresh one taken in
   * between) before deleting it. Returns true if the caller should retry now.
   */
  private reclaimIfStale(lockDir: string): boolean {
    const seen = this.readOwner(lockDir);
    if (!this.isStale(lockDir, seen)) return false;
    const grave = `${lockDir}.reclaim.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
    try {
      fs.renameSync(lockDir, grave);
    } catch {
      return true; // someone else reclaimed it, or it vanished: retry mkdir
    }
    const got = this.readOwner(grave);
    const same = got?.pid === seen?.pid && got?.since === seen?.since;
    if (!same && !this.isStale(grave, got)) {
      // A fresh lock was taken between our read and our rename: give it back.
      try {
        fs.renameSync(grave, lockDir);
      } catch {
        fs.rmSync(grave, { recursive: true, force: true });
      }
      return true;
    }
    fs.rmSync(grave, { recursive: true, force: true });
    return true;
  }

  async acquireLock(key: string): Promise<() => void> {
    const lockDir = this.lockDir(key);
    fs.mkdirSync(this.bucketDir(key), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    let backoff = 15;
    for (;;) {
      try {
        fs.mkdirSync(lockDir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (this.reclaimIfStale(lockDir)) continue;
        if (Date.now() > deadline) throw new LockTimeout(lockDir);
        await sleep(backoff + Math.floor(Math.random() * 10));
        backoff = Math.min(backoff * 2, 100);
        continue;
      }
      try {
        fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, since: Date.now() }));
      } catch (e) {
        // Our fresh directory was reclaimed from under us (a racing reclaimer): start over.
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      return () => {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      };
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
  inFlightActive(inFlight: InFlight | null, holdMs: number, now = Date.now(), reclaimOnOwnerExit = true): boolean {
    if (!inFlight) return false;
    if (now - inFlight.since >= holdMs) return false;
    if (reclaimOnOwnerExit && inFlight.ownerPid > 1 && !pidAlive(inFlight.ownerPid)) return false;
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
