#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/cli.ts
var import_node_child_process = require("node:child_process");
var import_node_fs3 = __toESM(require("node:fs"));
var import_node_os2 = __toESM(require("node:os"));
var import_node_path3 = __toESM(require("node:path"));

// src/config.ts
var import_node_fs = __toESM(require("node:fs"));
var DEFAULT_READ_ONLY_TOOLS = [
  "mcp__claude-in-chrome__screenshot",
  "mcp__claude-in-chrome__get_page_text",
  "mcp__claude-in-chrome__read_page",
  "mcp__claude-in-chrome__find",
  "mcp__claude-in-chrome__list_tabs",
  "mcp__claude-in-chrome__tabs_context_mcp",
  "mcp__claude-in-chrome__tabs_create_mcp",
  "mcp__claude-in-chrome__tabs_close_mcp",
  "mcp__claude-in-chrome__read_console_messages",
  "mcp__claude-in-chrome__read_network_requests",
  "mcp__claude-in-chrome__gif_creator",
  "mcp__claude-in-chrome__resize_window",
  "mcp__claude-in-chrome__shortcuts_list",
  "mcp__claude-in-chrome__update_plan"
];
var MAX_WAIT_CEILING_MS = 29e4;
var DEFAULT_CONFIG = {
  defaultMinIntervalMs: 0,
  unknownTargetPolicy: "pace-all",
  inFlightHoldMs: 12e4,
  staleLockMs: 15 * 6e4,
  maxWaitMs: 24e4,
  notifyAfterMs: 1e3,
  refuseUnpaceable: true,
  reclaimOnOwnerExit: true,
  readOnlyTools: [...DEFAULT_READ_ONLY_TOOLS],
  rules: [],
  refuse: []
};
var ConfigError = class extends Error {
  constructor(file, message) {
    super(`${file}: ${message}`);
    this.file = file;
    this.name = "ConfigError";
  }
  file;
};
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function nonNegInt(v, what, file) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new ConfigError(file, `${what} must be a non-negative number, got ${JSON.stringify(v)}`);
  }
  return Math.floor(v);
}
function stringArray(v, what, file) {
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || s.length === 0)) {
    throw new ConfigError(file, `${what} must be an array of non-empty strings`);
  }
  return v;
}
function validateRule(v, idx, file) {
  if (!isObject(v)) throw new ConfigError(file, `rules[${idx}] must be an object`);
  if (typeof v.name !== "string" || !v.name) throw new ConfigError(file, `rules[${idx}].name is required`);
  const where = `rules[${idx}] (${v.name})`;
  let target;
  if (typeof v.target === "string" && v.target) target = v.target;
  else if (Array.isArray(v.target) && v.target.length > 0) target = stringArray(v.target, `${where}.target`, file);
  else throw new ConfigError(file, `${where}.target must be a host glob or an array of them`);
  const rule = {
    name: v.name,
    target,
    minIntervalMs: nonNegInt(v.minIntervalMs, `${where}.minIntervalMs`, file)
  };
  if (v.perHost !== void 0) {
    if (typeof v.perHost !== "boolean") throw new ConfigError(file, `${where}.perHost must be a boolean`);
    rule.perHost = v.perHost;
  }
  if (v.maxPerHour !== void 0) {
    const n = nonNegInt(v.maxPerHour, `${where}.maxPerHour`, file);
    if (n < 1) throw new ConfigError(file, `${where}.maxPerHour must be at least 1`);
    rule.maxPerHour = n;
  }
  const known = /* @__PURE__ */ new Set(["name", "target", "minIntervalMs", "perHost", "maxPerHour"]);
  for (const k of Object.keys(v)) {
    if (!known.has(k)) throw new ConfigError(file, `${where}: unknown key "${k}"`);
  }
  return rule;
}
function validateRefuse(v, idx, file) {
  if (!isObject(v)) throw new ConfigError(file, `refuse[${idx}] must be an object`);
  if (typeof v.tool !== "string" || !v.tool) throw new ConfigError(file, `refuse[${idx}].tool is required`);
  const r = { tool: v.tool };
  if (v.reason !== void 0) {
    if (typeof v.reason !== "string") throw new ConfigError(file, `refuse[${idx}].reason must be a string`);
    r.reason = v.reason;
  }
  return r;
}
function validatePartial(raw, file) {
  if (!isObject(raw)) throw new ConfigError(file, "top level must be a JSON object");
  const out = {};
  const known = /* @__PURE__ */ new Set([
    "$schema",
    "defaultMinIntervalMs",
    "unknownTargetPolicy",
    "inFlightHoldMs",
    "staleLockMs",
    "maxWaitMs",
    "notifyAfterMs",
    "refuseUnpaceable",
    "reclaimOnOwnerExit",
    "readOnlyTools",
    "rules",
    "refuse"
  ]);
  for (const k of Object.keys(raw)) {
    if (!known.has(k)) throw new ConfigError(file, `unknown key "${k}"`);
  }
  if (raw.defaultMinIntervalMs !== void 0) {
    out.defaultMinIntervalMs = nonNegInt(raw.defaultMinIntervalMs, "defaultMinIntervalMs", file);
  }
  if (raw.unknownTargetPolicy !== void 0) {
    if (raw.unknownTargetPolicy !== "pace-all" && raw.unknownTargetPolicy !== "ignore") {
      throw new ConfigError(file, `unknownTargetPolicy must be "pace-all" or "ignore"`);
    }
    out.unknownTargetPolicy = raw.unknownTargetPolicy;
  }
  for (const k of ["inFlightHoldMs", "staleLockMs", "maxWaitMs", "notifyAfterMs"]) {
    if (raw[k] !== void 0) out[k] = nonNegInt(raw[k], k, file);
  }
  if (raw.refuseUnpaceable !== void 0) {
    if (typeof raw.refuseUnpaceable !== "boolean") throw new ConfigError(file, "refuseUnpaceable must be a boolean");
    out.refuseUnpaceable = raw.refuseUnpaceable;
  }
  if (raw.reclaimOnOwnerExit !== void 0) {
    if (typeof raw.reclaimOnOwnerExit !== "boolean") throw new ConfigError(file, "reclaimOnOwnerExit must be a boolean");
    out.reclaimOnOwnerExit = raw.reclaimOnOwnerExit;
  }
  if (raw.readOnlyTools !== void 0) out.readOnlyTools = stringArray(raw.readOnlyTools, "readOnlyTools", file);
  if (raw.rules !== void 0) {
    if (!Array.isArray(raw.rules)) throw new ConfigError(file, "rules must be an array");
    const rules = raw.rules.map((r, i) => validateRule(r, i, file));
    const seen = /* @__PURE__ */ new Set();
    for (const r of rules) {
      if (seen.has(r.name)) throw new ConfigError(file, `duplicate rule name "${r.name}"`);
      seen.add(r.name);
    }
    out.rules = rules;
  }
  if (raw.refuse !== void 0) {
    if (!Array.isArray(raw.refuse)) throw new ConfigError(file, "refuse must be an array");
    out.refuse = raw.refuse.map((r, i) => validateRefuse(r, i, file));
  }
  return out;
}
function mergeConfigs(layers) {
  const cfg = { ...DEFAULT_CONFIG, readOnlyTools: [...DEFAULT_CONFIG.readOnlyTools], rules: [], refuse: [] };
  const rules = /* @__PURE__ */ new Map();
  const refuse = /* @__PURE__ */ new Map();
  const readOnly = new Set(cfg.readOnlyTools);
  for (const layer of layers) {
    for (const k of ["defaultMinIntervalMs", "inFlightHoldMs", "staleLockMs", "maxWaitMs", "notifyAfterMs"]) {
      if (layer[k] !== void 0) cfg[k] = layer[k];
    }
    if (layer.unknownTargetPolicy !== void 0) cfg.unknownTargetPolicy = layer.unknownTargetPolicy;
    if (layer.refuseUnpaceable !== void 0) cfg.refuseUnpaceable = layer.refuseUnpaceable;
    if (layer.reclaimOnOwnerExit !== void 0) cfg.reclaimOnOwnerExit = layer.reclaimOnOwnerExit;
    for (const t of layer.readOnlyTools ?? []) readOnly.add(t);
    for (const r of layer.rules ?? []) rules.set(r.name, r);
    for (const r of layer.refuse ?? []) refuse.set(r.tool, r);
  }
  cfg.maxWaitMs = Math.min(cfg.maxWaitMs, MAX_WAIT_CEILING_MS);
  cfg.readOnlyTools = [...readOnly];
  cfg.rules = [...rules.values()];
  cfg.refuse = [...refuse.values()];
  return cfg;
}
function readLayer(file) {
  let text;
  try {
    text = import_node_fs.default.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return void 0;
    throw new ConfigError(file, `cannot read: ${e.message}`);
  }
  if (text.trim() === "") return {};
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(file, `invalid JSON: ${e.message}`);
  }
  return validatePartial(raw, file);
}
function loadConfig(files) {
  const layers = [];
  const used = [];
  for (const f of files) {
    if (!f) continue;
    const layer = readLayer(f);
    if (layer) {
      layers.push(layer);
      used.push(f);
    }
  }
  return { config: mergeConfigs(layers), files: used };
}
var globCache = /* @__PURE__ */ new Map();
function globToRegExp(glob) {
  let re = globCache.get(glob);
  if (!re) {
    const src = glob.split("").map((ch) => ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("");
    re = new RegExp(`^${src}$`, "i");
    globCache.set(glob, re);
  }
  return re;
}
function hostMatches(glob, host) {
  const g = glob.toLowerCase();
  const h = host.toLowerCase();
  if (g === h) return true;
  if (g.startsWith("*.") && h === g.slice(2)) return true;
  return globToRegExp(g).test(h);
}
function ruleTargets(rule) {
  return Array.isArray(rule.target) ? rule.target : [rule.target];
}
function rulesForHost(config, host) {
  return config.rules.filter((r) => ruleTargets(r).some((t) => hostMatches(t, host)));
}

// src/state.ts
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
function computeWaitMs({ lastFinishedAt, nowMs, minIntervalMs }) {
  if (lastFinishedAt === null || lastFinishedAt === void 0) return 0;
  if (!Number.isFinite(lastFinishedAt) || !Number.isFinite(nowMs) || !Number.isFinite(minIntervalMs)) return 0;
  if (minIntervalMs <= 0) return 0;
  const last = Math.min(lastFinishedAt, nowMs);
  return Math.max(0, Math.floor(last + minIntervalMs - nowMs));
}
var HOUR_MS = 36e5;
function computeCapWaitMs(recent, maxPerHour, nowMs) {
  if (!maxPerHour || maxPerHour < 1) return 0;
  const window = recent.filter((t) => Number.isFinite(t) && t > nowMs - HOUR_MS && t <= nowMs).sort((a, b) => a - b);
  if (window.length < maxPerHour) return 0;
  const idx = window.length - maxPerHour;
  const frees = window[idx] + HOUR_MS;
  return Math.max(0, Math.ceil(frees - nowMs));
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
var LockTimeout = class extends Error {
  constructor(lockDir) {
    super(`timed out acquiring lock ${lockDir}`);
    this.lockDir = lockDir;
    this.name = "LockTimeout";
  }
  lockDir;
};
var RECENT_KEEP_MS = 24 * HOUR_MS;
var TABS_KEEP_MS = 7 * 24 * HOUR_MS;
function sanitizeKey(s) {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, "_").slice(0, 120);
}
function ruleKey(ruleName) {
  return `r_${sanitizeKey(ruleName)}`;
}
function hostKey(host, ruleName) {
  return ruleName ? `r_${sanitizeKey(ruleName)}__${sanitizeKey(host)}` : `h_${sanitizeKey(host)}`;
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  import_node_fs2.default.writeFileSync(tmp, JSON.stringify(data));
  for (let attempt = 0; ; attempt++) {
    try {
      import_node_fs2.default.renameSync(tmp, file);
      return;
    } catch (e) {
      const code = e.code;
      if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < 20) {
        sleepSync(5);
        continue;
      }
      try {
        import_node_fs2.default.unlinkSync(tmp);
      } catch {
      }
      throw e;
    }
  }
}
function readJson(file) {
  try {
    const text = import_node_fs2.default.readFileSync(file, "utf8");
    if (!text.trim()) return void 0;
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
var Store = class {
  dir;
  staleLockMs;
  lockTimeoutMs;
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.staleLockMs = opts.staleLockMs ?? 15 * 6e4;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 6e4;
  }
  get targetsDir() {
    return import_node_path.default.join(this.dir, "targets");
  }
  bucketDir(key) {
    return import_node_path.default.join(this.targetsDir, key);
  }
  lockDir(key) {
    return import_node_path.default.join(this.bucketDir(key), "lock");
  }
  lastFile(key) {
    return import_node_path.default.join(this.bucketDir(key), "last.json");
  }
  get claimsDir() {
    return import_node_path.default.join(this.dir, "claims");
  }
  claimFile(toolUseId) {
    const safe = toolUseId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 100);
    const hash = import_node_crypto.default.createHash("sha1").update(toolUseId).digest("hex").slice(0, 10);
    return import_node_path.default.join(this.claimsDir, `${safe}-${hash}.json`);
  }
  /** Delete claim files whose call never reported back (older than `maxAgeMs`). */
  pruneClaims(maxAgeMs = 24 * HOUR_MS, now = Date.now()) {
    let removed = 0;
    let names;
    try {
      names = import_node_fs2.default.readdirSync(this.claimsDir);
    } catch {
      return 0;
    }
    for (const name of names) {
      const file = import_node_path.default.join(this.claimsDir, name);
      try {
        if (now - import_node_fs2.default.statSync(file).mtimeMs > maxAgeMs) {
          import_node_fs2.default.unlinkSync(file);
          removed++;
        }
      } catch {
      }
    }
    return removed;
  }
  get tabsFile() {
    return import_node_path.default.join(this.dir, "tabs.json");
  }
  listBuckets() {
    try {
      return import_node_fs2.default.readdirSync(this.targetsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    } catch {
      return [];
    }
  }
  /* ----- lock ----- */
  readOwner(lockDir) {
    return readJson(import_node_path.default.join(lockDir, "owner.json"));
  }
  isStale(lockDir, owner) {
    if (owner === void 0) {
      try {
        return Date.now() - import_node_fs2.default.statSync(lockDir).mtimeMs > 2e3;
      } catch {
        return true;
      }
    }
    const age = Date.now() - (owner.since ?? 0);
    return age > this.staleLockMs || typeof owner.pid === "number" && !pidAlive(owner.pid);
  }
  /**
   * Remove a stale lock so the caller can retry mkdir. Reclaim is done by
   * renaming the lock directory to a unique name: rename is atomic, so of
   * several contenders exactly one wins, and the winner then checks that what
   * it grabbed is still the stale lock it saw (not a fresh one taken in
   * between) before deleting it. Returns true if the caller should retry now.
   */
  reclaimIfStale(lockDir) {
    const seen = this.readOwner(lockDir);
    if (!this.isStale(lockDir, seen)) return false;
    const grave = `${lockDir}.reclaim.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
    try {
      import_node_fs2.default.renameSync(lockDir, grave);
    } catch {
      return true;
    }
    const got = this.readOwner(grave);
    const same = got?.pid === seen?.pid && got?.since === seen?.since;
    if (!same && !this.isStale(grave, got)) {
      try {
        import_node_fs2.default.renameSync(grave, lockDir);
      } catch {
        import_node_fs2.default.rmSync(grave, { recursive: true, force: true });
      }
      return true;
    }
    import_node_fs2.default.rmSync(grave, { recursive: true, force: true });
    return true;
  }
  async acquireLock(key) {
    const lockDir = this.lockDir(key);
    import_node_fs2.default.mkdirSync(this.bucketDir(key), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    let backoff = 15;
    for (; ; ) {
      try {
        import_node_fs2.default.mkdirSync(lockDir);
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        if (this.reclaimIfStale(lockDir)) continue;
        if (Date.now() > deadline) throw new LockTimeout(lockDir);
        await sleep(backoff + Math.floor(Math.random() * 10));
        backoff = Math.min(backoff * 2, 100);
        continue;
      }
      try {
        import_node_fs2.default.writeFileSync(import_node_path.default.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, since: Date.now() }));
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      return () => {
        try {
          import_node_fs2.default.rmSync(lockDir, { recursive: true, force: true });
        } catch {
        }
      };
    }
  }
  async withLock(key, fn) {
    const release2 = await this.acquireLock(key);
    try {
      return await fn();
    } finally {
      release2();
    }
  }
  /* ----- last.json ----- */
  readLast(key, label = key) {
    const rec = readJson(this.lastFile(key));
    return {
      label: typeof rec?.label === "string" ? rec.label : label,
      lastFinishedAt: typeof rec?.lastFinishedAt === "number" ? rec.lastFinishedAt : null,
      inFlight: rec?.inFlight && typeof rec.inFlight === "object" ? rec.inFlight : null,
      recent: Array.isArray(rec?.recent) ? rec.recent.filter((n) => typeof n === "number") : [],
      recentStarts: Array.isArray(rec?.recentStarts) ? rec.recentStarts.filter((n) => typeof n === "number") : [],
      totalCalls: typeof rec?.totalCalls === "number" ? rec.totalCalls : 0
    };
  }
  writeLast(key, rec) {
    import_node_fs2.default.mkdirSync(this.bucketDir(key), { recursive: true });
    writeAtomic(this.lastFile(key), rec);
  }
  /** Remove a bucket entirely (`paceline reset`). */
  removeBucket(key) {
    import_node_fs2.default.rmSync(this.bucketDir(key), { recursive: true, force: true });
  }
  /** True if the in-flight hold should still block others. */
  inFlightActive(inFlight, holdMs, now = Date.now(), reclaimOnOwnerExit = true) {
    if (!inFlight) return false;
    if (now - inFlight.since >= holdMs) return false;
    if (reclaimOnOwnerExit && inFlight.ownerPid > 1 && !pidAlive(inFlight.ownerPid)) return false;
    return true;
  }
  /** Mark a bucket finished: finish-time stamp, clear the matching in-flight hold. */
  finish(key, toolUseId, now = Date.now()) {
    const rec = this.readLast(key);
    if (!rec.inFlight || toolUseId === void 0 || rec.inFlight.toolUseId === toolUseId) {
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
  abandon(key, toolUseId) {
    const rec = this.readLast(key);
    if (rec.inFlight && rec.inFlight.toolUseId === toolUseId) {
      rec.inFlight = null;
      this.writeLast(key, rec);
    }
  }
  /* ----- claims ----- */
  writeClaim(claim) {
    const file = this.claimFile(claim.toolUseId);
    import_node_fs2.default.mkdirSync(import_node_path.default.dirname(file), { recursive: true });
    writeAtomic(file, claim);
  }
  takeClaim(toolUseId) {
    const file = this.claimFile(toolUseId);
    const claim = readJson(file);
    try {
      import_node_fs2.default.unlinkSync(file);
    } catch {
    }
    return claim && Array.isArray(claim.buckets) ? claim : void 0;
  }
  /* ----- tabs ----- */
  readTabs() {
    const tabs = readJson(this.tabsFile);
    return tabs && typeof tabs === "object" ? tabs : {};
  }
  updateTabs(entries, now = Date.now()) {
    const tabs = this.readTabs();
    for (const [id, e] of Object.entries(entries)) {
      if (!e.host) continue;
      tabs[String(id)] = { host: e.host, url: e.url, updatedAt: now };
    }
    for (const [id, e] of Object.entries(tabs)) {
      if (!e || typeof e.updatedAt !== "number" || e.updatedAt < now - TABS_KEEP_MS) delete tabs[id];
    }
    import_node_fs2.default.mkdirSync(this.dir, { recursive: true });
    writeAtomic(this.tabsFile, tabs);
    return tabs;
  }
  forgetTab(id) {
    const tabs = this.readTabs();
    if (id in tabs) {
      delete tabs[id];
      writeAtomic(this.tabsFile, tabs);
    }
  }
};

// src/targets.ts
var LOOPBACK = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]"]);
function isLoopback(host) {
  const h = host.toLowerCase();
  return LOOPBACK.has(h) || h.endsWith(".localhost") || h.startsWith("127.");
}

// src/pacer.ts
function ruleLabel(rule, host) {
  const targets = ruleTargets(rule).join(",");
  if (host && host !== targets) return `${rule.name} (${host})`;
  return rule.name === targets ? rule.name : `${rule.name} (${targets})`;
}
function bucketsFor(config, hosts) {
  const out = /* @__PURE__ */ new Map();
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
          maxPerHour: rule.maxPerHour
        });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
function fmtSeconds(ms) {
  return `${(ms / 1e3).toFixed(ms >= 1e4 ? 0 : 1)}s`;
}
async function pace(store, buckets, claim, opts) {
  const now = opts.now ?? Date.now;
  const start = now();
  const waits = {};
  const claimed = [];
  const abandonAll = async () => {
    for (const key of claimed) {
      try {
        await store.withLock(key, () => store.abandon(key, claim.toolUseId));
      } catch {
      }
    }
  };
  const giveUp = async (denied) => {
    await abandonAll();
    return { waitedMs: now() - start, waits, denied };
  };
  try {
    for (const bucket of buckets) {
      const bucketStart = now();
      for (; ; ) {
        const t = now();
        if (t > opts.deadlineMs) {
          return giveUp(
            `paceline: gave up after ${fmtSeconds(t - start)} waiting for ${bucket.label} (another call is still in flight). Try again in a moment.`
          );
        }
        const step = await store.withLock(bucket.key, () => {
          const rec = store.readLast(bucket.key, bucket.label);
          const t2 = now();
          if (store.inFlightActive(rec.inFlight, opts.inFlightHoldMs, t2, opts.reclaimOnOwnerExit ?? true)) {
            const remainingHold = Math.max(0, rec.inFlight.since + opts.inFlightHoldMs - t2);
            return { claimed: false, sleepMs: Math.min(200, remainingHold + 1), projectedMs: remainingHold + bucket.minIntervalMs, why: "in-flight" };
          }
          const intervalWait = computeWaitMs({ lastFinishedAt: rec.lastFinishedAt, nowMs: t2, minIntervalMs: bucket.minIntervalMs });
          const capWait = computeCapWaitMs(rec.recent, bucket.maxPerHour, t2);
          const wait = Math.max(intervalWait, capWait);
          if (wait > 0) {
            return { claimed: false, sleepMs: Math.min(wait, 2e3), projectedMs: wait, why: capWait > intervalWait ? "hourly-cap" : "interval" };
          }
          rec.label = bucket.label;
          rec.recentStarts = [...(rec.recentStarts ?? []).filter((t3) => t3 > t2 - 24 * 36e5), t2];
          rec.inFlight = {
            since: t2,
            pid: process.pid,
            ownerPid: claim.ownerPid ?? process.ppid,
            sessionId: claim.sessionId,
            toolUseId: claim.toolUseId,
            toolName: claim.toolName,
            agentId: claim.agentId
          };
          store.writeLast(bucket.key, rec);
          return { claimed: true };
        });
        if (step.claimed) break;
        if (step.why === "hourly-cap" && now() + step.projectedMs > opts.deadlineMs) {
          return giveUp(
            `paceline: hourly cap reached for ${bucket.label} (${bucket.maxPerHour}/hour). Next slot opens in ${fmtSeconds(step.projectedMs)}. Do something else and come back.`
          );
        }
        if (step.why === "interval" && now() + step.projectedMs > opts.deadlineMs) {
          return giveUp(
            `paceline: ${bucket.label} needs ${fmtSeconds(step.projectedMs)} more before the next call, longer than this hook may wait. Retry later.`
          );
        }
        await sleep(step.sleepMs);
      }
      claimed.push(bucket.key);
      waits[bucket.label] = now() - bucketStart;
    }
  } catch (e) {
    await abandonAll();
    throw e;
  }
  const record = {
    toolUseId: claim.toolUseId,
    sessionId: claim.sessionId,
    toolName: claim.toolName,
    agentId: claim.agentId,
    buckets: claimed,
    since: start
  };
  if (claimed.length > 0) {
    store.writeClaim(record);
    store.pruneClaims(void 0, now());
  }
  return { waitedMs: now() - start, waits };
}
async function release(store, toolUseId, now = Date.now()) {
  const claim = store.takeClaim(toolUseId);
  const keys = claim?.buckets ?? [];
  for (const key of keys) {
    await store.withLock(key, () => store.finish(key, toolUseId, now));
  }
  return keys;
}

// src/paths.ts
var import_node_os = __toESM(require("node:os"));
var import_node_path2 = __toESM(require("node:path"));
function stateDir(env = process.env) {
  if (env.PACELINE_STATE_DIR) return import_node_path2.default.resolve(env.PACELINE_STATE_DIR);
  if (env.XDG_CACHE_HOME) return import_node_path2.default.join(env.XDG_CACHE_HOME, "paceline");
  if (process.platform === "win32" && env.LOCALAPPDATA) {
    return import_node_path2.default.join(env.LOCALAPPDATA, "paceline");
  }
  return import_node_path2.default.join(import_node_os.default.homedir(), ".cache", "paceline");
}
function userConfigPath(env = process.env) {
  if (env.PACELINE_CONFIG) return import_node_path2.default.resolve(env.PACELINE_CONFIG);
  const claudeHome = env.CLAUDE_CONFIG_DIR ?? import_node_path2.default.join(import_node_os.default.homedir(), ".claude");
  return import_node_path2.default.join(claudeHome, "paceline.json");
}
function projectConfigPath(projectDir) {
  return import_node_path2.default.join(projectDir, ".claude", "paceline.json");
}

// src/cli.ts
var VERSION = "0.1.0";
var HELP = `paceline ${VERSION} \u2014 your agents take turns.

Usage:
  paceline status [--json]              per-target last call, in-flight hold, next allowed slot
  paceline reset <target>|--all         forget a target's state (rule name, host, or bucket key)
  paceline reset --tabs                 forget the browser tab \u2192 site map
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
`;
function die(msg, code = 1) {
  process.stderr.write(`paceline: ${msg}
`);
  process.exit(code);
}
function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return void 0;
  const v = args[i + 1];
  if (v === void 0 || v.startsWith("--")) die(`${name} needs a value`);
  return v;
}
function flags(args, name) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      const v = args[i + 1];
      if (v === void 0 || v.startsWith("--")) die(`${name} needs a value`);
      out.push(v);
      i++;
    }
  }
  return out;
}
function intFlag(args, name, dflt) {
  const v = flag(args, name);
  if (v === void 0) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) die(`${name} must be a non-negative number`);
  return Math.floor(n);
}
function loadCfg() {
  try {
    return loadConfig([userConfigPath(), projectConfigPath(process.cwd())]);
  } catch (e) {
    if (e instanceof ConfigError) die(e.message);
    throw e;
  }
}
function ago(ms) {
  if (ms < 1e3) return `${ms}ms ago`;
  if (ms < 6e4) return `${(ms / 1e3).toFixed(1)}s ago`;
  if (ms < 36e5) return `${Math.round(ms / 6e4)}m ago`;
  return `${(ms / 36e5).toFixed(1)}h ago`;
}
function inMs(ms) {
  if (ms <= 0) return "now";
  if (ms < 6e4) return `in ${(ms / 1e3).toFixed(1)}s`;
  return `in ${Math.round(ms / 6e4)}m`;
}
function statusRows(store, config) {
  const now = Date.now();
  const intervals = /* @__PURE__ */ new Map();
  for (const r of config.rules) intervals.set(ruleKey(r.name), r.minIntervalMs);
  const keys = new Set(store.listBuckets());
  for (const r of config.rules) if (!r.perHost) keys.add(ruleKey(r.name));
  const rows = [];
  for (const key of [...keys].sort()) {
    const rec = store.readLast(key, key);
    let interval = intervals.get(key) ?? null;
    if (interval === null) {
      const m = /^r_([^_].*?)__/.exec(key);
      const rule = m ? config.rules.find((r) => ruleKey(r.name) === `r_${m[1]}`) : void 0;
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
      inFlightOwnerAlive: active && rec.inFlight ? rec.inFlight.ownerPid > 1 ? pidAlive(rec.inFlight.ownerPid) : null : null,
      lastHour: rec.recent.filter((t) => t > now - 36e5).length,
      totalCalls: rec.totalCalls ?? 0
    });
  }
  return rows;
}
function pad(s, n) {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function cmdStatus(args) {
  const { config, files } = loadCfg();
  const store = new Store(stateDir());
  const rows = statusRows(store, config);
  const tabs = store.readTabs();
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ stateDir: store.dir, configFiles: files, targets: rows, tabs }, null, 2)}
`);
    return;
  }
  const now = Date.now();
  const lines = [];
  lines.push(`paceline ${VERSION}   state: ${store.dir}`);
  lines.push(`config: ${files.length ? files.join(" + ") : "(none found \u2014 nothing is paced; see paceline config)"}`);
  lines.push("");
  if (rows.length === 0) {
    lines.push("no targets yet.");
  } else {
    const w = Math.max(8, ...rows.map((r) => r.label.length)) + 2;
    lines.push(`${pad("TARGET", w)}${pad("INTERVAL", 10)}${pad("LAST CALL", 14)}${pad("NEXT ALLOWED", 14)}${pad("IN FLIGHT", 34)}LAST HOUR  TOTAL`);
    for (const r of rows) {
      const inflight = r.inFlight ? `${(r.inFlight.toolName ?? "?").replace("mcp__claude-in-chrome__", "chrome:")} ${ago(now - r.inFlight.since)}${r.inFlightOwnerAlive === false ? " (owner gone)" : ""}` : "\u2014";
      lines.push(
        `${pad(r.label, w)}${pad(r.minIntervalMs === null ? "\u2014" : `${r.minIntervalMs}ms`, 10)}${pad(r.lastFinishedAt ? ago(now - r.lastFinishedAt) : "never", 14)}${pad(r.inFlight ? `+${(r.minIntervalMs ?? 0) / 1e3}s after it` : inMs(r.nextAllowedInMs), 14)}${pad(inflight, 34)}${pad(String(r.lastHour), 11)}${r.totalCalls}`
      );
    }
  }
  const tabCount = Object.keys(tabs).length;
  lines.push("");
  lines.push(`browser tabs mapped: ${tabCount}${tabCount ? ` (${Object.entries(tabs).slice(0, 6).map(([id, t]) => `${id}\u2192${t.host}`).join(", ")}${tabCount > 6 ? ", \u2026" : ""})` : ""}`);
  process.stdout.write(`${lines.join("\n")}
`);
}
function cmdReset(args) {
  const store = new Store(stateDir());
  if (args.includes("--tabs")) {
    import_node_fs3.default.rmSync(store.tabsFile, { force: true });
    process.stdout.write("forgot all browser tabs.\n");
    if (args.length === 1) return;
  }
  if (args.includes("--all")) {
    const keys = store.listBuckets();
    for (const k of keys) store.removeBucket(k);
    import_node_fs3.default.rmSync(import_node_path3.default.join(store.dir, "claims"), { recursive: true, force: true });
    process.stdout.write(`reset ${keys.length} target(s).
`);
    return;
  }
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) die("reset needs a target, --all, or --tabs", 64);
  const { config } = loadCfg();
  const existing = store.listBuckets();
  const want = /* @__PURE__ */ new Set();
  const addRule = (name) => {
    want.add(ruleKey(name));
    const prefix = `${ruleKey(name)}__`;
    for (const k of existing) if (k.startsWith(prefix)) want.add(k);
  };
  for (const r of config.rules) {
    if (r.name === target) addRule(r.name);
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
  process.stdout.write(`reset ${hit.join(", ")}
`);
}
async function cmdRun(argv) {
  const sep = argv.indexOf("--");
  if (sep === -1 || sep === argv.length - 1) die("run needs `-- <cmd> [args]`", 64);
  const opts = argv.slice(0, sep);
  const cmd = argv.slice(sep + 1);
  const hosts = flags(opts, "--target").map((h) => h.toLowerCase());
  if (hosts.length === 0) die("run needs at least one --target <host>", 64);
  const interval = flag(opts, "--interval");
  const { config } = loadCfg();
  const store = new Store(stateDir(), { staleLockMs: config.staleLockMs });
  let buckets = bucketsFor(config, hosts);
  if (interval !== void 0) {
    const ms = Number(interval);
    if (!Number.isFinite(ms) || ms < 0) die("--interval must be a non-negative number of ms");
    const covered = new Set(buckets.map((b) => b.key));
    for (const h of hosts) {
      const key = hostKey(h);
      if (![...covered].some((k) => k === key) && !config.rules.some((r) => ruleTargets(r).some((t) => hostMatches(t, h)))) {
        buckets.push({ key, label: h, minIntervalMs: ms });
      }
    }
    buckets = buckets.sort((a, b) => a.key < b.key ? -1 : 1);
  }
  if (buckets.length === 0) {
    process.stderr.write(`paceline: no rule matches ${hosts.join(", ")} and no --interval given; running unpaced.
`);
  }
  const toolUseId = `run-${process.pid}-${Date.now().toString(36)}`;
  const t0 = Date.now();
  const result = await pace(
    store,
    buckets,
    { toolUseId, sessionId: "paceline-run", toolName: `run:${import_node_path3.default.basename(cmd[0])}`, ownerPid: process.pid },
    { deadlineMs: t0 + Math.max(config.maxWaitMs, 36e5), inFlightHoldMs: config.inFlightHoldMs }
  );
  if (result.denied) die(result.denied, 75);
  if (result.waitedMs >= config.notifyAfterMs) {
    process.stderr.write(`paceline: waited ${(result.waitedMs / 1e3).toFixed(1)}s for ${buckets.map((b) => b.label).join(", ")}
`);
  }
  const child = (0, import_node_child_process.spawn)(cmd[0], cmd.slice(1), { stdio: "inherit" });
  const finish = async (code) => {
    await release(store, toolUseId);
    process.exit(code);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      child.kill(sig);
    });
  }
  child.on("error", (e) => {
    process.stderr.write(`paceline: cannot run ${cmd[0]}: ${e.message}
`);
    void finish(127);
  });
  child.on("exit", (code, signal) => {
    void finish(code ?? (signal ? 128 + (import_node_os2.default.constants.signals[signal] ?? 0) : 1));
  });
}
function hookPath() {
  if (process.env.PACELINE_HOOK_PATH) return process.env.PACELINE_HOOK_PATH;
  return import_node_path3.default.join(__dirname, "hook.js");
}
function runHook(mode, payload, env) {
  return new Promise((resolve) => {
    const child = (0, import_node_child_process.spawn)(process.execPath, [hookPath(), mode], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => stdout += d.toString());
    child.stderr.on("data", (d) => stderr += d.toString());
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}
async function cmdTest(args) {
  const interval = intFlag(args, "--interval", 2e3);
  const calls = Math.max(1, intFlag(args, "--calls", 5));
  const parallel = Math.max(1, Math.min(calls, intFlag(args, "--parallel", calls)));
  const keep = args.includes("--keep");
  const hook = hookPath();
  if (!import_node_fs3.default.existsSync(hook)) die(`hook not found at ${hook} (run npm run build, or set PACELINE_HOOK_PATH)`);
  const tmp = import_node_fs3.default.mkdtempSync(import_node_path3.default.join(import_node_os2.default.tmpdir(), "paceline-test-"));
  const cfgFile = import_node_path3.default.join(tmp, "paceline.json");
  import_node_fs3.default.writeFileSync(
    cfgFile,
    JSON.stringify({ rules: [{ name: "paceline-test", target: "paceline.test", minIntervalMs: interval }] }, null, 2)
  );
  const env = {
    ...process.env,
    PACELINE_STATE_DIR: import_node_path3.default.join(tmp, "state"),
    PACELINE_CONFIG: cfgFile,
    PACELINE_NO_PROJECT_CONFIG: "1",
    PACELINE_DISABLED: ""
  };
  process.stdout.write(`paceline test: ${calls} call(s), minimum interval ${interval} ms, up to ${parallel} hook processes at once
`);
  process.stdout.write(`state: ${env.PACELINE_STATE_DIR}

`);
  const results = [];
  const wall0 = Date.now();
  let next = 0;
  const worker = async () => {
    while (next < calls) {
      const idx = next++;
      const toolUseId = `test-${idx}`;
      const payload = {
        session_id: `test-session-${idx % 2}`,
        hook_event_name: "PreToolUse",
        tool_name: "WebFetch",
        tool_input: { url: `https://paceline.test/call/${idx}` },
        tool_use_id: toolUseId
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
        return JSON.parse(r.stdout).systemMessage ?? "";
      } catch {
        return r.stdout ? "(non-JSON stdout!)" : "";
      }
    })();
    process.stdout.write(
      `  call #${r.idx}  pre took ${pad(`${r.preEnd - r.preStart} ms`, 9)} released at +${pad(`${r.postEnd - wall0} ms`, 8)}${msg ? `  ${msg}` : ""}
`
    );
  }
  const rec = new Store(env.PACELINE_STATE_DIR).readLast(ruleKey("paceline-test"));
  const starts = [...rec.recentStarts ?? []].sort((a, b) => a - b);
  const finishes = [...rec.recent].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < Math.min(starts.length, finishes.length + 1); i++) gaps.push(starts[i] - finishes[i - 1]);
  const observed = [];
  for (let i = 1; i < results.length; i++) observed.push(results[i].preEnd - results[i - 1].postEnd);
  const required = (calls - 1) * interval;
  const minGap = gaps.length ? Math.min(...gaps) : Infinity;
  const nonJson = results.filter((r) => r.stdout.trim() && !r.stdout.trim().startsWith("{"));
  process.stdout.write("\n");
  process.stdout.write(`  finish\u2192start gaps recorded by the hooks (ms): ${gaps.join(", ") || "n/a"}   min ${Number.isFinite(minGap) ? minGap : "n/a"}   required \u2265 ${interval}
`);
  process.stdout.write(`  observed from outside, incl. process overhead:  ${observed.join(", ") || "n/a"}
`);
  process.stdout.write(`  wall time ${(wall / 1e3).toFixed(2)} s   required \u2265 ${(required / 1e3).toFixed(2)} s
`);
  const ok = gaps.length === calls - 1 && minGap >= interval && wall >= required && finishes.length === calls && nonJson.length === 0;
  process.stdout.write(
    `
${ok ? "PASS" : "FAIL"}: ${finishes.length}/${calls} calls finished, ${gaps.filter((g) => g >= interval).length}/${gaps.length} gaps \u2265 ${interval} ms${finishes.length !== calls ? ` (expected ${calls} finishes)` : ""}${nonJson.length ? ", non-JSON stdout from a hook" : ""}
`
  );
  if (!keep) import_node_fs3.default.rmSync(tmp, { recursive: true, force: true });
  else process.stdout.write(`kept ${tmp}
`);
  process.exit(ok ? 0 : 1);
}
function cmdConfig() {
  const { config, files } = loadCfg();
  process.stdout.write(`user config:    ${userConfigPath()}${import_node_fs3.default.existsSync(userConfigPath()) ? "" : "  (missing)"}
`);
  process.stdout.write(`project config: ${projectConfigPath(process.cwd())}${import_node_fs3.default.existsSync(projectConfigPath(process.cwd())) ? "" : "  (missing)"}
`);
  process.stdout.write(`merged from:    ${files.join(", ") || "(defaults only)"}

`);
  process.stdout.write(`${JSON.stringify(config, null, 2)}
`);
}
function cmdLog(args) {
  const n = intFlag(args, "-n", 50);
  const file = import_node_path3.default.join(stateDir(), "paceline.log");
  if (!import_node_fs3.default.existsSync(file)) die(`no log yet at ${file}`);
  const lines = import_node_fs3.default.readFileSync(file, "utf8").trimEnd().split("\n");
  process.stdout.write(`${lines.slice(-n).join("\n")}
`);
}
async function main() {
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
      process.stdout.write(`state:   ${stateDir()}
user:    ${userConfigPath()}
project: ${projectConfigPath(process.cwd())}
hook:    ${hookPath()}
`);
      return;
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}
`);
      return;
    case void 0:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;
    default:
      die(`unknown command "${cmd}"

${HELP}`, 64);
  }
}
void main().catch((e) => {
  process.stderr.write(`paceline: ${e instanceof Error ? e.stack ?? e.message : String(e)}
`);
  process.exit(1);
});
