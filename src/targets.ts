import type { TabsMap } from "./state.js";

export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  tool_response?: unknown;
  agent_id?: string;
  agent_type?: string;
  error?: string;
  [k: string]: unknown;
}

export const CHROME_PREFIX = "mcp__claude-in-chrome__";

/** `computer` actions that only look at the page. */
const READ_ONLY_COMPUTER_ACTIONS = new Set(["screenshot", "zoom", "wait", "cursor_position"]);

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]"]);

export function isLoopback(host: string): boolean {
  const h = host.toLowerCase();
  return LOOPBACK.has(h) || h.endsWith(".localhost") || h.startsWith("127.");
}

/** Hostname (no port, no userinfo, lowercased) from a URL string. */
export function hostFromUrl(s: unknown): string | null {
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

const URL_RE = /\bhttps?:\/\/[^\s'"`<>|)\]},;]+/gi;
const GIT_SSH_RE = /\b[\w.-]+@([a-z0-9][a-z0-9.-]*\.[a-z]{2,}):/gi;
const HOST_TOKEN_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:\/|$)/i;
const GH_RE = /(?:^|[;&|(]|\$\(|`)\s*(?:[A-Z_][A-Z0-9_]*=\S*\s+)*gh\s/m;

/** Every external host a shell command talks to, best effort. */
export function hostsFromCommand(command: unknown): string[] {
  if (typeof command !== "string" || !command) return [];
  const hosts = new Set<string>();
  for (const m of command.matchAll(URL_RE)) {
    const h = hostFromUrl(m[0]);
    if (h) hosts.add(h);
  }
  for (const m of command.matchAll(GIT_SSH_RE)) {
    if (m[1]) hosts.add(m[1].toLowerCase());
  }
  if (GH_RE.test(command)) hosts.add("api.github.com");
  // `curl example.com/x`, `wget -q api.foo.io/bar`, `http GET host/...`
  const segments = command.split(/(?:&&|\|\||[;|]|\$\(|`)/);
  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/);
    const cmdIdx = tokens.findIndex((t) => !/^[A-Z_][A-Z0-9_]*=/.test(t));
    const cmd = tokens[cmdIdx]?.replace(/^.*\//, "");
    if (!cmd || !/^(curl|wget|http|https|xh|httpie|curlie)$/.test(cmd)) continue;
    const rest = tokens.slice(cmdIdx + 1);
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i]!;
      if (tok.startsWith("-")) {
        if (FLAG_WITH_VALUE_RE.test(tok) && !tok.includes("=")) i++; // skip the flag's value
        continue;
      }
      if (tok.includes("://")) continue;
      const bare = tok.replace(/^['"]|['"]$/g, "");
      if (HOST_TOKEN_RE.test(bare) && !looksLikeFile(bare)) {
        hosts.add(bare.split(/[/:]/)[0]!.toLowerCase());
      }
    }
  }
  return [...hosts];
}

/** curl/wget/httpie flags that consume the next token, so it is not a host. */
const FLAG_WITH_VALUE_RE =
  /^(?:-[oOdHXuAebcTKmwxFPUEtQ]|--(?:output|output-document|output-dir|data|data-raw|data-binary|data-urlencode|data-ascii|json|header|request|user|user-agent|referer|cookie|cookie-jar|upload-file|config|retry|retry-delay|retry-max-time|max-time|connect-timeout|write-out|proxy|cacert|cert|key|resolve|form|form-string|post-data|post-file|password|timeout|tries|limit-rate|wait|directory-prefix|header|auth|auth-type|pretty|style|print|session|session-read-only|timeout|max-redirs|range|time-cond|interface|dns-servers|unix-socket|abstract-unix-socket|oauth2-bearer|aws-sigv4|variable|expand-url|url-query|rate|speed-limit|speed-time|stderr|trace|trace-ascii|dump-header|egd-file|engine|ciphers|tls13-ciphers|pinnedpubkey|crlfile|hostpubmd5|hostpubsha256|pubkey|socks4|socks4a|socks5|socks5-hostname|preproxy|proxy-user|proxy-header|noproxy|local-port|happy-eyeballs-timeout-ms|keepalive-time|continue-at|limit-rate|max-filesize|netrc-file|alt-svc|hsts|etag-save|etag-compare|create-file-mode|parallel-max|ftp-port|krb|login-options|mail-from|mail-rcpt|tftp-blksize|telnet-option|quote|request-target|service-name|tlsuser|tlspassword|tlsauthtype|delegation|ssl-sessions|ech|ip-tos|vlan-priority|upload-flags))$/;

const FILE_EXT_RE =
  /\.(?:json|txt|html?|xml|csv|log|md|js|mjs|cjs|ts|py|sh|bash|zsh|rb|go|rs|java|c|h|cpp|tgz|gz|bz2|xz|zip|tar|7z|rar|pem|crt|cer|key|p12|pfx|yaml|yml|toml|ini|cfg|conf|env|pdf|png|jpe?g|gif|svg|webp|mp[34]|wav|out|tmp|bak|lock|map|sql|db|sqlite|bin|exe|dmg|deb|rpm|apk|jar|war|whl|egg|iso|img|patch|diff)(?:[/:]|$)/i;

function looksLikeFile(token: string): boolean {
  return FILE_EXT_RE.test(token.split(/[/:]/)[0]!) || token.startsWith("./") || token.startsWith("/");
}

const URL_KEYS = new Set([
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
  "hostname",
]);

/** URL-ish strings anywhere in a tool input object (two levels deep). */
export function hostsFromObject(obj: unknown, depth = 2): string[] {
  const hosts = new Set<string>();
  const visit = (v: unknown, d: number, key?: string): void => {
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
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (URL_KEYS.has(k) || typeof val === "object") visit(val, d - 1, k);
    }
  };
  visit(obj, depth);
  return [...hosts];
}

export function tabIdOf(toolInput: unknown): string | undefined {
  if (!toolInput || typeof toolInput !== "object") return undefined;
  const t = (toolInput as Record<string, unknown>).tabId ?? (toolInput as Record<string, unknown>).tab_id;
  if (typeof t === "number" && Number.isFinite(t)) return String(t);
  if (typeof t === "string" && t.trim()) return t.trim();
  return undefined;
}

export interface ResolvedTargets {
  hosts: string[];
  /** A browser action on a tab we have never seen navigate. */
  unknownTab?: string;
  /** The call makes no request to any site (read-only). */
  readOnly: boolean;
}

export function isReadOnlyTool(toolName: string, toolInput: unknown, readOnlyTools: readonly string[]): boolean {
  if (readOnlyTools.includes(toolName)) return true;
  if (toolName === `${CHROME_PREFIX}computer` && toolInput && typeof toolInput === "object") {
    const action = (toolInput as Record<string, unknown>).action;
    if (typeof action === "string" && READ_ONLY_COMPUTER_ACTIONS.has(action)) return true;
  }
  return false;
}

/**
 * Which external hosts does this tool call touch?
 *  - WebFetch / navigate / anything with a URL: the URL's host.
 *  - Bash: every host in the command text; `gh` ⇒ api.github.com.
 *  - Browser actions on a tab: the host that tab was last seen on.
 */
export function resolveTargets(input: HookInput, tabs: TabsMap, readOnlyTools: readonly string[]): ResolvedTargets {
  const toolName = input.tool_name ?? "";
  const toolInput = input.tool_input;
  if (isReadOnlyTool(toolName, toolInput, readOnlyTools)) return { hosts: [], readOnly: true };

  const hosts = new Set<string>();
  if (toolName === "Bash" || toolName === "bash") {
    const cmd = toolInput && typeof toolInput === "object" ? (toolInput as Record<string, unknown>).command : undefined;
    for (const h of hostsFromCommand(cmd)) hosts.add(h);
    return { hosts: [...hosts], readOnly: false };
  }

  for (const h of hostsFromObject(toolInput)) hosts.add(h);

  if (toolName.startsWith(CHROME_PREFIX)) {
    const tabId = tabIdOf(toolInput);
    if (tabId !== undefined) {
      const known = tabs[tabId];
      if (known?.host) hosts.add(known.host);
      else if (hosts.size === 0) return { hosts: [], unknownTab: tabId, readOnly: false };
    }
  }
  return { hosts: [...hosts], readOnly: false };
}

/* ---------- unpaceable calls ---------- */

const FETCH_RE = /(^|[^.\w])fetch\s*\(/gmu;

export function countFetchCalls(code: unknown): number {
  if (typeof code !== "string") return 0;
  return [...code.matchAll(FETCH_RE)].length;
}

/** Why a call cannot be paced at all (several requests inside one tool call). */
export function unpaceableReason(toolName: string, toolInput: unknown): string | undefined {
  if (toolName === `${CHROME_PREFIX}browser_batch`) {
    return "paceline: browser_batch runs several browser actions inside one tool call, so no gap can be enforced between them. Make one call per action instead.";
  }
  if (toolName === `${CHROME_PREFIX}javascript_tool` && toolInput && typeof toolInput === "object") {
    const ti = toolInput as Record<string, unknown>;
    const code = ti.text ?? ti.code ?? ti.script;
    const n = countFetchCalls(code);
    if (n >= 2) {
      return `paceline: this script contains ${n} fetch() calls that would fire back to back. Make one request per tool call so the minimum interval can apply.`;
    }
  }
  return undefined;
}

/* ---------- tab maps from results ---------- */

const TAB_LINE_RE = /(?:tab(?:[ _-]?id)?|id)\W{0,4}(\d{1,12})\b[^\n]{0,400}?(https?:\/\/[^\s'"<>)\]]+)/gi;
const TAB_LINE_RE_REVERSED = /(https?:\/\/[^\s'"<>)\]]+)[^\n]{0,400}?\btab(?:[ _-]?id)?\W{0,4}(\d{1,12})\b/gi;

/** Extract `tabId → host` pairs from a tool result of any shape. */
export function tabsFromResponse(response: unknown): Record<string, { host: string; url?: string }> {
  const out: Record<string, { host: string; url?: string }> = {};
  const addPair = (id: unknown, url: unknown): void => {
    const key = typeof id === "number" ? String(id) : typeof id === "string" ? id.trim() : "";
    const host = hostFromUrl(url);
    if (key && host) out[key] = { host, url: String(url) };
  };
  const visitText = (text: string): void => {
    for (const m of text.matchAll(TAB_LINE_RE)) addPair(m[1], m[2]);
    for (const m of text.matchAll(TAB_LINE_RE_REVERSED)) addPair(m[2], m[1]);
  };
  const visit = (v: unknown, depth: number): void => {
    if (depth < 0 || v === null || v === undefined) return;
    if (typeof v === "string") {
      if (v.length < 200_000) {
        // Results often embed JSON as text.
        if (/^\s*[[{]/.test(v)) {
          try {
            visit(JSON.parse(v), depth - 1);
            return;
          } catch {
            /* not JSON */
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
      const o = v as Record<string, unknown>;
      const id = o.tabId ?? o.tab_id ?? o.id;
      const url = o.url ?? o.href;
      if ((typeof id === "number" || typeof id === "string") && typeof url === "string") addPair(id, url);
      for (const val of Object.values(o)) visit(val, depth - 1);
    }
  };
  visit(response, 6);
  return out;
}
