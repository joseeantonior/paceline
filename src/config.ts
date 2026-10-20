import fs from "node:fs";

export interface Rule {
  /** Unique name; project config overrides user config rule-by-rule on this key. */
  name: string;
  /** Host glob(s): `api.github.com`, `*.example.com` (also matches `example.com`). */
  target: string | string[];
  /** Minimum gap, in ms, between the end of one call and the start of the next. */
  minIntervalMs: number;
  /** Pace each concrete host separately instead of one bucket per rule. */
  perHost?: boolean;
  /** Optional rolling cap: at most this many finished calls per 60 minutes. */
  maxPerHour?: number;
}

export interface RefuseRule {
  /** Exact tool name, or a glob with `*`. */
  tool: string;
  reason?: string;
}

export interface Config {
  defaultMinIntervalMs: number;
  unknownTargetPolicy: "pace-all" | "ignore";
  inFlightHoldMs: number;
  staleLockMs: number;
  maxWaitMs: number;
  notifyAfterMs: number;
  refuseUnpaceable: boolean;
  readOnlyTools: string[];
  rules: Rule[];
  refuse: RefuseRule[];
}

/** Tools that read the page or the browser without sending a request to the site. */
export const DEFAULT_READ_ONLY_TOOLS: readonly string[] = [
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
  "mcp__claude-in-chrome__update_plan",
];

/** The PreToolUse hook timeout in hooks.json is 300 s; stay safely under it. */
export const MAX_WAIT_CEILING_MS = 290_000;

export const DEFAULT_CONFIG: Config = {
  defaultMinIntervalMs: 0,
  unknownTargetPolicy: "pace-all",
  inFlightHoldMs: 120_000,
  staleLockMs: 15 * 60_000,
  maxWaitMs: 240_000,
  notifyAfterMs: 1_000,
  refuseUnpaceable: true,
  readOnlyTools: [...DEFAULT_READ_ONLY_TOOLS],
  rules: [],
  refuse: [],
};

export class ConfigError extends Error {
  constructor(public readonly file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = "ConfigError";
  }
}

type Partial_ = Partial<Config>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonNegInt(v: unknown, what: string, file: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new ConfigError(file, `${what} must be a non-negative number, got ${JSON.stringify(v)}`);
  }
  return Math.floor(v);
}

function stringArray(v: unknown, what: string, file: string): string[] {
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || s.length === 0)) {
    throw new ConfigError(file, `${what} must be an array of non-empty strings`);
  }
  return v as string[];
}

function validateRule(v: unknown, idx: number, file: string): Rule {
  if (!isObject(v)) throw new ConfigError(file, `rules[${idx}] must be an object`);
  if (typeof v.name !== "string" || !v.name) throw new ConfigError(file, `rules[${idx}].name is required`);
  const where = `rules[${idx}] (${v.name})`;
  let target: string | string[];
  if (typeof v.target === "string" && v.target) target = v.target;
  else if (Array.isArray(v.target) && v.target.length > 0) target = stringArray(v.target, `${where}.target`, file);
  else throw new ConfigError(file, `${where}.target must be a host glob or an array of them`);
  const rule: Rule = {
    name: v.name,
    target,
    minIntervalMs: nonNegInt(v.minIntervalMs, `${where}.minIntervalMs`, file),
  };
  if (v.perHost !== undefined) {
    if (typeof v.perHost !== "boolean") throw new ConfigError(file, `${where}.perHost must be a boolean`);
    rule.perHost = v.perHost;
  }
  if (v.maxPerHour !== undefined) {
    const n = nonNegInt(v.maxPerHour, `${where}.maxPerHour`, file);
    if (n < 1) throw new ConfigError(file, `${where}.maxPerHour must be at least 1`);
    rule.maxPerHour = n;
  }
  const known = new Set(["name", "target", "minIntervalMs", "perHost", "maxPerHour"]);
  for (const k of Object.keys(v)) {
    if (!known.has(k)) throw new ConfigError(file, `${where}: unknown key "${k}"`);
  }
  return rule;
}

function validateRefuse(v: unknown, idx: number, file: string): RefuseRule {
  if (!isObject(v)) throw new ConfigError(file, `refuse[${idx}] must be an object`);
  if (typeof v.tool !== "string" || !v.tool) throw new ConfigError(file, `refuse[${idx}].tool is required`);
  const r: RefuseRule = { tool: v.tool };
  if (v.reason !== undefined) {
    if (typeof v.reason !== "string") throw new ConfigError(file, `refuse[${idx}].reason must be a string`);
    r.reason = v.reason;
  }
  return r;
}

/** Validate one config file's parsed JSON. Only keys present are returned. */
export function validatePartial(raw: unknown, file: string): Partial_ {
  if (!isObject(raw)) throw new ConfigError(file, "top level must be a JSON object");
  const out: Partial_ = {};
  const known = new Set<string>([
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
    "refuse",
  ]);
  for (const k of Object.keys(raw)) {
    if (!known.has(k)) throw new ConfigError(file, `unknown key "${k}"`);
  }
  if (raw.defaultMinIntervalMs !== undefined) {
    out.defaultMinIntervalMs = nonNegInt(raw.defaultMinIntervalMs, "defaultMinIntervalMs", file);
  }
  if (raw.unknownTargetPolicy !== undefined) {
    if (raw.unknownTargetPolicy !== "pace-all" && raw.unknownTargetPolicy !== "ignore") {
      throw new ConfigError(file, `unknownTargetPolicy must be "pace-all" or "ignore"`);
    }
    out.unknownTargetPolicy = raw.unknownTargetPolicy;
  }
  for (const k of ["inFlightHoldMs", "staleLockMs", "maxWaitMs", "notifyAfterMs"] as const) {
    if (raw[k] !== undefined) out[k] = nonNegInt(raw[k], k, file);
  }
  if (raw.refuseUnpaceable !== undefined) {
    if (typeof raw.refuseUnpaceable !== "boolean") throw new ConfigError(file, "refuseUnpaceable must be a boolean");
    out.refuseUnpaceable = raw.refuseUnpaceable;
  }
  if (raw.readOnlyTools !== undefined) out.readOnlyTools = stringArray(raw.readOnlyTools, "readOnlyTools", file);
  if (raw.rules !== undefined) {
    if (!Array.isArray(raw.rules)) throw new ConfigError(file, "rules must be an array");
    const rules = raw.rules.map((r, i) => validateRule(r, i, file));
    const seen = new Set<string>();
    for (const r of rules) {
      if (seen.has(r.name)) throw new ConfigError(file, `duplicate rule name "${r.name}"`);
      seen.add(r.name);
    }
    out.rules = rules;
  }
  if (raw.refuse !== undefined) {
    if (!Array.isArray(raw.refuse)) throw new ConfigError(file, "refuse must be an array");
    out.refuse = raw.refuse.map((r, i) => validateRefuse(r, i, file));
  }
  return out;
}

/**
 * Merge layers in order (later wins). Scalars override; `rules` and `refuse`
 * merge by `name` / `tool`; `readOnlyTools` is a union with the defaults.
 */
export function mergeConfigs(layers: Partial_[]): Config {
  const cfg: Config = { ...DEFAULT_CONFIG, readOnlyTools: [...DEFAULT_CONFIG.readOnlyTools], rules: [], refuse: [] };
  const rules = new Map<string, Rule>();
  const refuse = new Map<string, RefuseRule>();
  const readOnly = new Set<string>(cfg.readOnlyTools);
  for (const layer of layers) {
    for (const k of ["defaultMinIntervalMs", "inFlightHoldMs", "staleLockMs", "maxWaitMs", "notifyAfterMs"] as const) {
      if (layer[k] !== undefined) cfg[k] = layer[k];
    }
    if (layer.unknownTargetPolicy !== undefined) cfg.unknownTargetPolicy = layer.unknownTargetPolicy;
    if (layer.refuseUnpaceable !== undefined) cfg.refuseUnpaceable = layer.refuseUnpaceable;
    for (const t of layer.readOnlyTools ?? []) readOnly.add(t);
    for (const r of layer.rules ?? []) rules.set(r.name, r);
    for (const r of layer.refuse ?? []) refuse.set(r.tool, r);
  }
  // hooks.json gives the PreToolUse hook 300 s; a longer wait would time out (and block) anyway.
  cfg.maxWaitMs = Math.min(cfg.maxWaitMs, MAX_WAIT_CEILING_MS);
  cfg.readOnlyTools = [...readOnly];
  cfg.rules = [...rules.values()];
  cfg.refuse = [...refuse.values()];
  return cfg;
}

export interface LoadedConfig {
  config: Config;
  /** Files that existed and were read, in merge order. */
  files: string[];
}

function readLayer(file: string): Partial_ | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError(file, `cannot read: ${(e as Error).message}`);
  }
  if (text.trim() === "") return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(file, `invalid JSON: ${(e as Error).message}`);
  }
  return validatePartial(raw, file);
}

/** Load user config then project config. Throws ConfigError on a bad file. */
export function loadConfig(files: Array<string | undefined>): LoadedConfig {
  const layers: Partial_[] = [];
  const used: string[] = [];
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

/* ---------- host globs ---------- */

const globCache = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
  let re = globCache.get(glob);
  if (!re) {
    const src = glob
      .split("")
      .map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
      .join("");
    re = new RegExp(`^${src}$`, "i");
    globCache.set(glob, re);
  }
  return re;
}

/**
 * Case-insensitive host glob. `*` matches any run of characters (dots
 * included), `?` one character. `*.example.com` also matches the bare
 * `example.com`, because that is what people mean.
 */
export function hostMatches(glob: string, host: string): boolean {
  const g = glob.toLowerCase();
  const h = host.toLowerCase();
  if (g === h) return true;
  if (g.startsWith("*.") && h === g.slice(2)) return true;
  return globToRegExp(g).test(h);
}

export function ruleTargets(rule: Rule): string[] {
  return Array.isArray(rule.target) ? rule.target : [rule.target];
}

export function rulesForHost(config: Config, host: string): Rule[] {
  return config.rules.filter((r) => ruleTargets(r).some((t) => hostMatches(t, host)));
}

export function refuseFor(config: Config, toolName: string): RefuseRule | undefined {
  return config.refuse.find((r) => hostMatches(r.tool, toolName));
}
