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

// src/hook.ts
var import_node_path4 = __toESM(require("node:path"));

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
function refuseFor(config, toolName) {
  return config.refuse.find((r) => hostMatches(r.tool, toolName));
}

// src/log.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var MAX_LOG_BYTES = 5 * 1024 * 1024;
function logLine(dir, message) {
  try {
    import_node_fs2.default.mkdirSync(dir, { recursive: true });
    const file = import_node_path.default.join(dir, "paceline.log");
    try {
      const st = import_node_fs2.default.statSync(file);
      if (st.size > MAX_LOG_BYTES) import_node_fs2.default.renameSync(file, file + ".1");
    } catch {
    }
    import_node_fs2.default.appendFileSync(file, `${(/* @__PURE__ */ new Date()).toISOString()} [${process.pid}] ${message}
`);
  } catch {
  }
}

// src/state.ts
var import_node_fs3 = __toESM(require("node:fs"));
var import_node_path2 = __toESM(require("node:path"));
function computeWaitMs({ lastFinishedAt, nowMs, minIntervalMs }) {
  if (lastFinishedAt === null || lastFinishedAt === void 0) return 0;
  if (!Number.isFinite(lastFinishedAt) || !Number.isFinite(nowMs) || !Number.isFinite(minIntervalMs)) return 0;
  if (minIntervalMs <= 0) return 0;
  return Math.max(0, Math.floor(lastFinishedAt + minIntervalMs - nowMs));
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
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  import_node_fs3.default.writeFileSync(tmp, JSON.stringify(data));
  try {
    import_node_fs3.default.renameSync(tmp, file);
  } catch (e) {
    try {
      import_node_fs3.default.writeFileSync(file, JSON.stringify(data));
    } finally {
      try {
        import_node_fs3.default.unlinkSync(tmp);
      } catch {
      }
    }
    if (e.code !== "EPERM" && e.code !== "EEXIST") throw e;
  }
}
function readJson(file) {
  try {
    const text = import_node_fs3.default.readFileSync(file, "utf8");
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
    return import_node_path2.default.join(this.dir, "targets");
  }
  bucketDir(key) {
    return import_node_path2.default.join(this.targetsDir, key);
  }
  lockDir(key) {
    return import_node_path2.default.join(this.bucketDir(key), "lock");
  }
  lastFile(key) {
    return import_node_path2.default.join(this.bucketDir(key), "last.json");
  }
  get claimsDir() {
    return import_node_path2.default.join(this.dir, "claims");
  }
  claimFile(toolUseId) {
    const safe = toolUseId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 150);
    return import_node_path2.default.join(this.claimsDir, `${safe}.json`);
  }
  /** Delete claim files whose call never reported back (older than `maxAgeMs`). */
  pruneClaims(maxAgeMs = 24 * HOUR_MS, now = Date.now()) {
    let removed = 0;
    let names;
    try {
      names = import_node_fs3.default.readdirSync(this.claimsDir);
    } catch {
      return 0;
    }
    for (const name of names) {
      const file = import_node_path2.default.join(this.claimsDir, name);
      try {
        if (now - import_node_fs3.default.statSync(file).mtimeMs > maxAgeMs) {
          import_node_fs3.default.unlinkSync(file);
          removed++;
        }
      } catch {
      }
    }
    return removed;
  }
  get tabsFile() {
    return import_node_path2.default.join(this.dir, "tabs.json");
  }
  listBuckets() {
    try {
      return import_node_fs3.default.readdirSync(this.targetsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    } catch {
      return [];
    }
  }
  /* ----- lock ----- */
  /** Returns true if the lock was removed (dead owner or too old). */
  reclaimIfStale(lockDir) {
    const owner = readJson(import_node_path2.default.join(lockDir, "owner.json"));
    let stale = false;
    if (owner === void 0) {
      try {
        const st = import_node_fs3.default.statSync(lockDir);
        stale = Date.now() - st.mtimeMs > 2e3;
      } catch {
        return true;
      }
    } else {
      const age = Date.now() - (owner.since ?? 0);
      stale = age > this.staleLockMs || typeof owner.pid === "number" && !pidAlive(owner.pid);
    }
    if (!stale) return false;
    try {
      import_node_fs3.default.rmSync(lockDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
  async acquireLock(key) {
    const lockDir = this.lockDir(key);
    import_node_fs3.default.mkdirSync(this.bucketDir(key), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    let backoff = 15;
    for (; ; ) {
      try {
        import_node_fs3.default.mkdirSync(lockDir);
        import_node_fs3.default.writeFileSync(import_node_path2.default.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, since: Date.now() }));
        return () => {
          try {
            import_node_fs3.default.rmSync(lockDir, { recursive: true, force: true });
          } catch {
          }
        };
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        if (this.reclaimIfStale(lockDir)) continue;
        if (Date.now() > deadline) throw new LockTimeout(lockDir);
        await sleep(backoff + Math.floor(Math.random() * 10));
        backoff = Math.min(backoff * 2, 100);
      }
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
    import_node_fs3.default.mkdirSync(this.bucketDir(key), { recursive: true });
    writeAtomic(this.lastFile(key), rec);
  }
  /** Remove a bucket entirely (`paceline reset`). */
  removeBucket(key) {
    import_node_fs3.default.rmSync(this.bucketDir(key), { recursive: true, force: true });
  }
  /** True if the in-flight hold should still block others. */
  inFlightActive(inFlight, holdMs, now = Date.now()) {
    if (!inFlight) return false;
    if (now - inFlight.since >= holdMs) return false;
    if (inFlight.ownerPid > 1 && !pidAlive(inFlight.ownerPid)) return false;
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
    import_node_fs3.default.mkdirSync(import_node_path2.default.dirname(file), { recursive: true });
    writeAtomic(file, claim);
  }
  takeClaim(toolUseId) {
    const file = this.claimFile(toolUseId);
    const claim = readJson(file);
    try {
      import_node_fs3.default.unlinkSync(file);
    } catch {
    }
    return claim && Array.isArray(claim.buckets) ? claim : void 0;
  }
  /** Buckets whose in-flight record names this tool use (fallback when no claim file). */
  bucketsInFlightFor(toolUseId) {
    return this.listBuckets().filter((k) => this.readLast(k).inFlight?.toolUseId === toolUseId);
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
    import_node_fs3.default.mkdirSync(this.dir, { recursive: true });
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
var CHROME_PREFIX = "mcp__claude-in-chrome__";
var READ_ONLY_COMPUTER_ACTIONS = /* @__PURE__ */ new Set(["screenshot", "zoom", "wait", "cursor_position"]);
var LOOPBACK = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]"]);
function isLoopback(host) {
  const h = host.toLowerCase();
  return LOOPBACK.has(h) || h.endsWith(".localhost") || h.startsWith("127.");
}
function hostFromUrl(s) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return null;
  try {
    const u = new URL(t);
    if (!u.hostname) return null;
    return u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}
var URL_RE = /\bhttps?:\/\/[^\s'"`<>|)\]},;]+/gi;
var GIT_SSH_RE = /\b[\w.-]+@([a-z0-9][a-z0-9.-]*\.[a-z]{2,}):/gi;
var HOST_TOKEN_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:\/|$)/i;
var GH_RE = /(?:^|[;&|(]|\$\(|`)\s*(?:[A-Z_][A-Z0-9_]*=\S*\s+)*gh\s/m;
function hostsFromCommand(command) {
  if (typeof command !== "string" || !command) return [];
  const hosts = /* @__PURE__ */ new Set();
  for (const m of command.matchAll(URL_RE)) {
    const h = hostFromUrl(m[0]);
    if (h) hosts.add(h);
  }
  for (const m of command.matchAll(GIT_SSH_RE)) {
    if (m[1]) hosts.add(m[1].toLowerCase());
  }
  if (GH_RE.test(command)) hosts.add("api.github.com");
  const segments = command.split(/(?:&&|\|\||[;|]|\$\(|`)/);
  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/);
    const cmdIdx = tokens.findIndex((t) => !/^[A-Z_][A-Z0-9_]*=/.test(t));
    const cmd = tokens[cmdIdx]?.replace(/^.*\//, "");
    if (!cmd || !/^(curl|wget|http|https|xh|httpie|curlie)$/.test(cmd)) continue;
    const rest = tokens.slice(cmdIdx + 1);
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (tok.startsWith("-")) {
        if (FLAG_WITH_VALUE_RE.test(tok) && !tok.includes("=")) i++;
        continue;
      }
      if (tok.includes("://")) continue;
      const bare = tok.replace(/^['"]|['"]$/g, "");
      if (HOST_TOKEN_RE.test(bare) && !looksLikeFile(bare)) {
        hosts.add(bare.split(/[/:]/)[0].toLowerCase());
      }
    }
  }
  return [...hosts];
}
var FLAG_WITH_VALUE_RE = /^(?:-[oOdHXuAebcTKmwxFPUEtQ]|--(?:output|output-document|output-dir|data|data-raw|data-binary|data-urlencode|data-ascii|json|header|request|user|user-agent|referer|cookie|cookie-jar|upload-file|config|retry|retry-delay|retry-max-time|max-time|connect-timeout|write-out|proxy|cacert|cert|key|resolve|form|form-string|post-data|post-file|password|timeout|tries|limit-rate|wait|directory-prefix|header|auth|auth-type|pretty|style|print|session|session-read-only|timeout|max-redirs|range|time-cond|interface|dns-servers|unix-socket|abstract-unix-socket|oauth2-bearer|aws-sigv4|variable|expand-url|url-query|rate|speed-limit|speed-time|stderr|trace|trace-ascii|dump-header|egd-file|engine|ciphers|tls13-ciphers|pinnedpubkey|crlfile|hostpubmd5|hostpubsha256|pubkey|socks4|socks4a|socks5|socks5-hostname|preproxy|proxy-user|proxy-header|noproxy|local-port|happy-eyeballs-timeout-ms|keepalive-time|continue-at|limit-rate|max-filesize|netrc-file|alt-svc|hsts|etag-save|etag-compare|create-file-mode|parallel-max|ftp-port|krb|login-options|mail-from|mail-rcpt|tftp-blksize|telnet-option|quote|request-target|service-name|tlsuser|tlspassword|tlsauthtype|delegation|ssl-sessions|ech|ip-tos|vlan-priority|upload-flags))$/;
var FILE_EXT_RE = /\.(?:json|txt|html?|xml|csv|log|md|js|mjs|cjs|ts|py|sh|bash|zsh|rb|go|rs|java|c|h|cpp|tgz|gz|bz2|xz|zip|tar|7z|rar|pem|crt|cer|key|p12|pfx|yaml|yml|toml|ini|cfg|conf|env|pdf|png|jpe?g|gif|svg|webp|mp[34]|wav|out|tmp|bak|lock|map|sql|db|sqlite|bin|exe|dmg|deb|rpm|apk|jar|war|whl|egg|iso|img|patch|diff)(?:[/:]|$)/i;
function looksLikeFile(token) {
  return FILE_EXT_RE.test(token.split(/[/:]/)[0]) || token.startsWith("./") || token.startsWith("/");
}
var URL_KEYS = /* @__PURE__ */ new Set([
  "url",
  "uri",
  "href",
  "endpoint",
  "base_url",
  "baseurl",
  "baseURL",
  "server",
  "api_url",
  "apiUrl",
  "webhook",
  "webhook_url",
  "target",
  "host",
  "hostname"
]);
function hostsFromObject(obj, depth = 2) {
  const hosts = /* @__PURE__ */ new Set();
  const visit = (v, d, key) => {
    if (typeof v === "string") {
      const h = hostFromUrl(v);
      if (h) hosts.add(h);
      else if (key && (key === "host" || key === "hostname") && HOST_TOKEN_RE.test(v)) hosts.add(v.toLowerCase());
      return;
    }
    if (d < 0 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item, d - 1, key);
      return;
    }
    for (const [k, val] of Object.entries(v)) {
      if (URL_KEYS.has(k) || typeof val === "object") visit(val, d - 1, k);
    }
  };
  visit(obj, depth);
  return [...hosts];
}
function tabIdOf(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return void 0;
  const t = toolInput.tabId ?? toolInput.tab_id;
  if (typeof t === "number" && Number.isFinite(t)) return String(t);
  if (typeof t === "string" && t.trim()) return t.trim();
  return void 0;
}
function isReadOnlyTool(toolName, toolInput, readOnlyTools) {
  if (readOnlyTools.includes(toolName)) return true;
  if (toolName === `${CHROME_PREFIX}computer` && toolInput && typeof toolInput === "object") {
    const action = toolInput.action;
    if (typeof action === "string" && READ_ONLY_COMPUTER_ACTIONS.has(action)) return true;
  }
  return false;
}
function resolveTargets(input, tabs, readOnlyTools) {
  const toolName = input.tool_name ?? "";
  const toolInput = input.tool_input;
  if (isReadOnlyTool(toolName, toolInput, readOnlyTools)) return { hosts: [], readOnly: true };
  const hosts = /* @__PURE__ */ new Set();
  if (toolName === "Bash" || toolName === "bash") {
    const cmd = toolInput && typeof toolInput === "object" ? toolInput.command : void 0;
    for (const h of hostsFromCommand(cmd)) hosts.add(h);
    return { hosts: [...hosts], readOnly: false };
  }
  for (const h of hostsFromObject(toolInput)) hosts.add(h);
  if (toolName.startsWith(CHROME_PREFIX)) {
    const tabId = tabIdOf(toolInput);
    if (tabId !== void 0) {
      const known = tabs[tabId];
      if (known?.host) hosts.add(known.host);
      else if (hosts.size === 0) return { hosts: [], unknownTab: tabId, readOnly: false };
    }
  }
  return { hosts: [...hosts], readOnly: false };
}
var FETCH_RE = /(^|[^.\w])fetch\s*\(/gmu;
function countFetchCalls(code) {
  if (typeof code !== "string") return 0;
  return [...code.matchAll(FETCH_RE)].length;
}
function unpaceableReason(toolName, toolInput) {
  if (toolName === `${CHROME_PREFIX}browser_batch`) {
    return "paceline: browser_batch runs several browser actions inside one tool call, so no gap can be enforced between them. Make one call per action instead.";
  }
  if (toolName === `${CHROME_PREFIX}javascript_tool` && toolInput && typeof toolInput === "object") {
    const ti = toolInput;
    const code = ti.text ?? ti.code ?? ti.script;
    const n = countFetchCalls(code);
    if (n >= 2) {
      return `paceline: this script contains ${n} fetch() calls that would fire back to back. Make one request per tool call so the minimum interval can apply.`;
    }
  }
  return void 0;
}
var TAB_LINE_RE = /(?:tab(?:[ _-]?id)?|id)\W{0,4}(\d{1,12})\b[^\n]{0,400}?(https?:\/\/[^\s'"<>)\]]+)/gi;
var TAB_LINE_RE_REVERSED = /(https?:\/\/[^\s'"<>)\]]+)[^\n]{0,400}?\btab(?:[ _-]?id)?\W{0,4}(\d{1,12})\b/gi;
function tabsFromResponse(response) {
  const out = {};
  const addPair = (id, url) => {
    const key = typeof id === "number" ? String(id) : typeof id === "string" ? id.trim() : "";
    const host = hostFromUrl(url);
    if (key && host) out[key] = { host, url: String(url) };
  };
  const visitText = (text) => {
    for (const m of text.matchAll(TAB_LINE_RE)) addPair(m[1], m[2]);
    for (const m of text.matchAll(TAB_LINE_RE_REVERSED)) addPair(m[2], m[1]);
  };
  const visit = (v, depth) => {
    if (depth < 0 || v === null || v === void 0) return;
    if (typeof v === "string") {
      if (v.length < 2e5) {
        if (/^\s*[[{]/.test(v)) {
          try {
            visit(JSON.parse(v), depth - 1);
            return;
          } catch {
          }
        }
        visitText(v);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth - 1);
      return;
    }
    if (typeof v === "object") {
      const o = v;
      const id = o.tabId ?? o.tab_id ?? o.id;
      const url = o.url ?? o.href;
      if ((typeof id === "number" || typeof id === "string") && typeof url === "string") addPair(id, url);
      for (const val of Object.values(o)) visit(val, depth - 1);
    }
  };
  visit(response, 6);
  return out;
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
function allRuleBuckets(config) {
  return config.rules.map((rule) => ({
    key: ruleKey(rule.name),
    label: ruleLabel(rule),
    minIntervalMs: rule.minIntervalMs,
    maxPerHour: rule.maxPerHour
  })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
function fmtSeconds(ms) {
  return `${(ms / 1e3).toFixed(ms >= 1e4 ? 0 : 1)}s`;
}
async function pace(store, buckets, claim, opts) {
  const now = opts.now ?? Date.now;
  const start = now();
  const waits = {};
  const claimed = [];
  const abandonAll = () => {
    for (const key of claimed) store.abandon(key, claim.toolUseId);
  };
  for (const bucket of buckets) {
    const bucketStart = now();
    for (; ; ) {
      const t = now();
      if (t > opts.deadlineMs) {
        abandonAll();
        return {
          waitedMs: t - start,
          waits,
          denied: `paceline: gave up after ${fmtSeconds(t - start)} waiting for ${bucket.label} (another call is still in flight). Try again in a moment.`
        };
      }
      const step = await store.withLock(bucket.key, () => {
        const rec = store.readLast(bucket.key, bucket.label);
        const t2 = now();
        if (store.inFlightActive(rec.inFlight, opts.inFlightHoldMs, t2)) {
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
        abandonAll();
        return {
          waitedMs: now() - start,
          waits,
          denied: `paceline: hourly cap reached for ${bucket.label} (${bucket.maxPerHour}/hour). Next slot opens in ${fmtSeconds(step.projectedMs)}. Do something else and come back.`
        };
      }
      if (step.why === "interval" && now() + step.projectedMs > opts.deadlineMs) {
        abandonAll();
        return {
          waitedMs: now() - start,
          waits,
          denied: `paceline: ${bucket.label} needs ${fmtSeconds(step.projectedMs)} more before the next call, longer than this hook may wait. Retry later.`
        };
      }
      await sleep(step.sleepMs);
    }
    claimed.push(bucket.key);
    waits[bucket.label] = now() - bucketStart;
  }
  const record = {
    toolUseId: claim.toolUseId,
    sessionId: claim.sessionId,
    toolName: claim.toolName,
    agentId: claim.agentId,
    buckets: claimed,
    since: start
  };
  if (claimed.length > 0) store.writeClaim(record);
  return { waitedMs: now() - start, waits };
}
async function release(store, toolUseId, now = Date.now()) {
  const claim = store.takeClaim(toolUseId);
  const keys = claim?.buckets ?? store.bucketsInFlightFor(toolUseId);
  if (!claim) store.pruneClaims(void 0, now);
  for (const key of keys) {
    await store.withLock(key, () => store.finish(key, toolUseId, now));
  }
  return keys;
}

// src/paths.ts
var import_node_os = __toESM(require("node:os"));
var import_node_path3 = __toESM(require("node:path"));
function stateDir(env = process.env) {
  if (env.PACELINE_STATE_DIR) return import_node_path3.default.resolve(env.PACELINE_STATE_DIR);
  if (env.XDG_CACHE_HOME) return import_node_path3.default.join(env.XDG_CACHE_HOME, "paceline");
  if (process.platform === "win32" && env.LOCALAPPDATA) {
    return import_node_path3.default.join(env.LOCALAPPDATA, "paceline");
  }
  return import_node_path3.default.join(import_node_os.default.homedir(), ".cache", "paceline");
}
function userConfigPath(env = process.env) {
  if (env.PACELINE_CONFIG) return import_node_path3.default.resolve(env.PACELINE_CONFIG);
  const claudeHome = env.CLAUDE_CONFIG_DIR ?? import_node_path3.default.join(import_node_os.default.homedir(), ".claude");
  return import_node_path3.default.join(claudeHome, "paceline.json");
}
function projectConfigPath(projectDir2) {
  return import_node_path3.default.join(projectDir2, ".claude", "paceline.json");
}
function projectDir(hookCwd, env = process.env) {
  if (env.PACELINE_NO_PROJECT_CONFIG) return void 0;
  return env.CLAUDE_PROJECT_DIR ?? hookCwd;
}

// src/hook.ts
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
    if (process.stdin.isTTY) resolve("");
  });
}
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}
function deny(reason, extra = {}) {
  emit({
    ...extra,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  });
}
function fmtWait(ms) {
  return ms >= 1e4 ? `${Math.round(ms / 1e3)}s` : `${(ms / 1e3).toFixed(1)}s`;
}
function toolUseIdFor(input) {
  if (typeof input.tool_use_id === "string" && input.tool_use_id) return input.tool_use_id;
  return `${input.session_id ?? "nosession"}:${input.tool_name ?? "notool"}`;
}
function short(s, n = 60) {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
}
async function handlePre(input, store, state) {
  const toolName = input.tool_name;
  if (!toolName) return;
  let config;
  let configError;
  try {
    config = loadConfig([userConfigPath(), (() => {
      const p = projectDir(input.cwd);
      return p ? projectConfigPath(p) : void 0;
    })()]).config;
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    configError = e;
    config = DEFAULT_CONFIG;
  }
  const tabs = toolName.startsWith(CHROME_PREFIX) ? store.readTabs() : {};
  const resolved = resolveTargets(input, tabs, config.readOnlyTools);
  if (resolved.readOnly) return;
  if (configError) {
    if (resolved.hosts.length > 0 || resolved.unknownTab !== void 0) {
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
  let buckets;
  const notes = [];
  if (resolved.unknownTab !== void 0) {
    if (config.unknownTargetPolicy === "ignore" || config.rules.length === 0) {
      logLine(state, `pre PASS ${toolName} unknown tab ${resolved.unknownTab} (policy ${config.unknownTargetPolicy})`);
      return;
    }
    buckets = allRuleBuckets(config);
    notes.push(
      `paceline: tab ${resolved.unknownTab} has no known site yet, so this call was paced against all ${buckets.length} rule(s) (unknownTargetPolicy: pace-all). Navigate in the tab first, or set "unknownTargetPolicy": "ignore".`
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
      ownerPid: process.ppid
    },
    { deadlineMs: Date.now() + config.maxWaitMs, inFlightHoldMs: config.inFlightHoldMs }
  );
  const labels = buckets.map((b) => b.label).join(", ");
  if (result.denied) {
    logLine(state, `pre DENY ${toolName} ${short(toolUseId, 40)} after ${result.waitedMs}ms: ${labels}`);
    deny(result.denied);
    return;
  }
  logLine(state, `pre GO   ${toolName} ${short(toolUseId, 40)} waited ${result.waitedMs}ms for ${labels}${input.agent_id ? ` agent=${input.agent_id}` : ""}`);
  if (result.waitedMs >= config.notifyAfterMs) {
    const parts = Object.entries(result.waits).filter(([, ms]) => ms >= 50).map(([label, ms]) => `${fmtWait(ms)} for ${label}`);
    notes.unshift(`paceline: waited ${parts.length ? parts.join(", ") : fmtWait(result.waitedMs)}`);
  }
  if (notes.length) {
    emit({
      systemMessage: notes.join("\n"),
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: notes.join("\n") }
    });
  }
}
async function handlePost(input, store, state) {
  const toolName = input.tool_name ?? "";
  const toolUseId = toolUseIdFor(input);
  const now = Date.now();
  const released = await release(store, toolUseId, now);
  const event = input.hook_event_name ?? "PostToolUse";
  if (toolName.startsWith(CHROME_PREFIX)) {
    const entries = {};
    const tabId = tabIdOf(input.tool_input);
    if (event === "PostToolUse" && tabId !== void 0 && input.tool_input && typeof input.tool_input === "object") {
      const url = input.tool_input.url;
      const host = hostFromUrl(url);
      if (host) entries[tabId] = { host, url: String(url) };
    }
    Object.assign(entries, tabsFromResponse(input.tool_response));
    if (toolName === `${CHROME_PREFIX}tabs_close_mcp` && tabId !== void 0 && event === "PostToolUse") {
      store.forgetTab(tabId);
    }
    if (Object.keys(entries).length > 0) store.updateTabs(entries, now);
  }
  if (released.length > 0 || event !== "PostToolUse") {
    logLine(state, `${event === "PostToolUse" ? "post" : event} ${toolName} ${short(toolUseId, 40)} released ${released.join(", ") || "(nothing)"}`);
  }
}
async function main() {
  const mode = process.argv[2] ?? "";
  if (mode !== "pre" && mode !== "post") {
    process.stderr.write("usage: hook.js pre|post  (reads a Claude Code hook event on stdin)\n");
    process.exit(64);
  }
  if (process.env.PACELINE_DISABLED && process.env.PACELINE_DISABLED !== "0") return;
  const raw = await readStdin();
  if (!raw.trim()) return;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    if (mode === "pre") deny("paceline: could not parse the hook input as JSON.");
    return;
  }
  if (!input || typeof input !== "object") return;
  const state = stateDir();
  const store = new Store(state, { lockTimeoutMs: 3e4 });
  try {
    if (mode === "pre") await handlePre(input, store, state);
    else await handlePost(input, store, state);
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    logLine(state, `${mode} ERROR ${input.tool_name ?? ""}: ${msg}`);
    if (mode === "pre") {
      deny(`paceline: internal error, call blocked to stay safe (${msg}). See ${import_node_path4.default.join(state, "paceline.log")}.`);
    }
  }
}
void main().then(
  () => process.exit(0),
  (e) => {
    process.stderr.write(`paceline: ${e instanceof Error ? e.stack ?? e.message : String(e)}
`);
    process.exit(1);
  }
);
