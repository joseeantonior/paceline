import { type Config, type Rule, rulesForHost, ruleTargets } from "./config.js";
import { computeCapWaitMs, computeWaitMs, hostKey, ruleKey, sleep, Store, type Claim } from "./state.js";
import { isLoopback } from "./targets.js";

export interface Bucket {
  key: string;
  label: string;
  minIntervalMs: number;
  maxPerHour?: number;
}

function ruleLabel(rule: Rule, host?: string): string {
  const targets = ruleTargets(rule).join(",");
  if (host && host !== targets) return `${rule.name} (${host})`;
  return rule.name === targets ? rule.name : `${rule.name} (${targets})`;
}

/** Throttle buckets a set of hosts maps to under this config. */
export function bucketsFor(config: Config, hosts: readonly string[]): Bucket[] {
  const out = new Map<string, Bucket>();
  for (const host of hosts) {
    const rules = rulesForHost(config, host);
    if (rules.length === 0) {
      if (config.defaultMinIntervalMs > 0 && !isLoopback(host)) {
        const key = hostKey(host);
        if (!out.has(key)) out.set(key, { key, label: host, minIntervalMs: config.defaultMinIntervalMs });
      }
      continue;
    }
    for (const rule of rules) {
      const key = rule.perHost ? hostKey(host, rule.name) : ruleKey(rule.name);
      if (!out.has(key)) {
        out.set(key, {
          key,
          label: rule.perHost ? ruleLabel(rule, host) : ruleLabel(rule),
          minIntervalMs: rule.minIntervalMs,
          maxPerHour: rule.maxPerHour,
        });
      }
    }
  }
  return [...out.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Every configured rule as a bucket — used for `unknownTargetPolicy: pace-all`.
 * A `perHost` rule has one bucket per host already seen, so every existing
 * `r_<rule>__<host>` bucket is claimed too; otherwise the unknown call would
 * only touch a bucket nobody else uses.
 */
export function allRuleBuckets(config: Config, store?: Store): Bucket[] {
  const out = new Map<string, Bucket>();
  const existing = store ? store.listBuckets() : [];
  for (const rule of config.rules) {
    const base: Bucket = { key: ruleKey(rule.name), label: ruleLabel(rule), minIntervalMs: rule.minIntervalMs, maxPerHour: rule.maxPerHour };
    if (rule.perHost) {
      const prefix = `${ruleKey(rule.name)}__`;
      for (const key of existing) {
        if (key.startsWith(prefix)) {
          const rec = store!.readLast(key, key);
          out.set(key, { ...base, key, label: rec.label !== key ? rec.label : `${rule.name} (${key.slice(prefix.length)})` });
        }
      }
    }
    out.set(base.key, base);
  }
  return [...out.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export interface ClaimInfo {
  toolUseId: string;
  sessionId?: string;
  toolName?: string;
  agentId?: string;
  ownerPid?: number;
}

export interface PaceOptions {
  /** Absolute ms timestamp after which we give up and deny. */
  deadlineMs: number;
  inFlightHoldMs: number;
  reclaimOnOwnerExit?: boolean;
  now?: () => number;
}

export interface PaceResult {
  waitedMs: number;
  /** Per-bucket wait in ms, keyed by label. */
  waits: Record<string, number>;
  /** Set when the call must not proceed. */
  denied?: string;
}

function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
}

/**
 * Claim every bucket in order (keys sorted ⇒ no lock-order deadlock between
 * concurrent callers). For each bucket: wait for any in-flight call to
 * finish, then for the minimum interval since the last finish, then mark
 * ourselves in flight. The mkdir lock is held only around the
 * read-decide-write, never while sleeping.
 */
export async function pace(store: Store, buckets: readonly Bucket[], claim: ClaimInfo, opts: PaceOptions): Promise<PaceResult> {
  const now = opts.now ?? Date.now;
  const start = now();
  const waits: Record<string, number> = {};
  const claimed: string[] = [];

  const abandonAll = async (): Promise<void> => {
    for (const key of claimed) {
      try {
        await store.withLock(key, () => store.abandon(key, claim.toolUseId));
      } catch {
        /* best effort */
      }
    }
  };
  const giveUp = async (denied: string): Promise<PaceResult> => {
    await abandonAll();
    return { waitedMs: now() - start, waits, denied };
  };

  try {
    for (const bucket of buckets) {
      const bucketStart = now();
      for (;;) {
        const t = now();
        if (t > opts.deadlineMs) {
          return giveUp(
            `paceline: gave up after ${fmtSeconds(t - start)} waiting for ${bucket.label} (another call is still in flight). Try again in a moment.`,
          );
        }
        type Step = { claimed: true } | { claimed: false; sleepMs: number; projectedMs: number; why: string };
        const step: Step = await store.withLock(bucket.key, () => {
          const rec = store.readLast(bucket.key, bucket.label);
          const t2 = now();
          if (store.inFlightActive(rec.inFlight, opts.inFlightHoldMs, t2, opts.reclaimOnOwnerExit ?? true)) {
            const remainingHold = Math.max(0, rec.inFlight!.since + opts.inFlightHoldMs - t2);
            return { claimed: false, sleepMs: Math.min(200, remainingHold + 1), projectedMs: remainingHold + bucket.minIntervalMs, why: "in-flight" };
          }
          const intervalWait = computeWaitMs({ lastFinishedAt: rec.lastFinishedAt, nowMs: t2, minIntervalMs: bucket.minIntervalMs });
          const capWait = computeCapWaitMs(rec.recent, bucket.maxPerHour, t2);
          const wait = Math.max(intervalWait, capWait);
          if (wait > 0) {
            return { claimed: false, sleepMs: Math.min(wait, 2_000), projectedMs: wait, why: capWait > intervalWait ? "hourly-cap" : "interval" };
          }
          rec.label = bucket.label;
          rec.recentStarts = [...(rec.recentStarts ?? []).filter((t) => t > t2 - 24 * 3_600_000), t2];
          rec.inFlight = {
            since: t2,
            pid: process.pid,
            ownerPid: claim.ownerPid ?? process.ppid,
            sessionId: claim.sessionId,
            toolUseId: claim.toolUseId,
            toolName: claim.toolName,
            agentId: claim.agentId,
          };
          store.writeLast(bucket.key, rec);
          return { claimed: true };
        });
        if (step.claimed) break;
        if (step.why === "hourly-cap" && now() + step.projectedMs > opts.deadlineMs) {
          return giveUp(
            `paceline: hourly cap reached for ${bucket.label} (${bucket.maxPerHour}/hour). Next slot opens in ${fmtSeconds(step.projectedMs)}. Do something else and come back.`,
          );
        }
        if (step.why === "interval" && now() + step.projectedMs > opts.deadlineMs) {
          return giveUp(
            `paceline: ${bucket.label} needs ${fmtSeconds(step.projectedMs)} more before the next call, longer than this hook may wait. Retry later.`,
          );
        }
        await sleep(step.sleepMs);
      }
      claimed.push(bucket.key);
      waits[bucket.label] = now() - bucketStart;
    }
  } catch (e) {
    // Never leave a half-claimed call holding buckets for the whole in-flight window.
    await abandonAll();
    throw e;
  }

  const record: Claim = {
    toolUseId: claim.toolUseId,
    sessionId: claim.sessionId,
    toolName: claim.toolName,
    agentId: claim.agentId,
    buckets: claimed,
    since: start,
  };
  if (claimed.length > 0) {
    store.writeClaim(record);
    store.pruneClaims(undefined, now()); // paced calls are rare enough to carry the sweep
  }
  return { waitedMs: now() - start, waits };
}

/** Mark the call finished on every bucket it claimed. Returns bucket keys released. */
export async function release(store: Store, toolUseId: string, now = Date.now()): Promise<string[]> {
  const claim = store.takeClaim(toolUseId);
  const keys = claim?.buckets ?? [];
  for (const key of keys) {
    await store.withLock(key, () => store.finish(key, toolUseId, now));
  }
  return keys;
}
