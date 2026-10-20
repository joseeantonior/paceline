import { describe, expect, it } from "vitest";
import { DEFAULT_READ_ONLY_TOOLS } from "../src/config.js";
import {
  countFetchCalls,
  hostFromUrl,
  hostsFromCommand,
  hostsFromObject,
  isReadOnlyTool,
  resolveTargets,
  tabsFromResponse,
  unpaceableReason,
} from "../src/targets.js";

describe("hostFromUrl", () => {
  it("extracts lowercase hostnames without port or userinfo", () => {
    expect(hostFromUrl("https://API.GitHub.com:443/repos?x=1")).toBe("api.github.com");
    expect(hostFromUrl("http://user:pw@shop.myshopify.com:8080/")).toBe("shop.myshopify.com");
    expect(hostFromUrl("ws://x.example.com/socket")).toBe("x.example.com");
  });
  it("rejects non-URLs", () => {
    expect(hostFromUrl("example.com/path")).toBeNull();
    expect(hostFromUrl("not a url")).toBeNull();
    expect(hostFromUrl(42)).toBeNull();
    expect(hostFromUrl("mailto:a@b.com")).toBeNull();
  });
});

describe("hostsFromCommand", () => {
  it("finds every URL host", () => {
    expect(hostsFromCommand(`curl -s https://api.github.com/repos && wget 'http://cdn.example.com/a.tgz'`).sort()).toEqual([
      "api.github.com",
      "cdn.example.com",
    ]);
  });
  it("maps gh to api.github.com", () => {
    expect(hostsFromCommand("gh pr list")).toEqual(["api.github.com"]);
    expect(hostsFromCommand("cd x && gh api repos/o/r")).toEqual(["api.github.com"]);
    expect(hostsFromCommand("GH_TOKEN=x gh issue create")).toEqual(["api.github.com"]);
    expect(hostsFromCommand("echo $(gh pr view 1)")).toEqual(["api.github.com"]);
    expect(hostsFromCommand("ghostscript file.ps")).toEqual([]);
    expect(hostsFromCommand("hugh -x")).toEqual([]);
  });
  it("handles git ssh remotes", () => {
    expect(hostsFromCommand("git push git@github.com:o/r.git main")).toEqual(["github.com"]);
  });
  it("handles bare hosts after curl/wget", () => {
    expect(hostsFromCommand("curl -X POST -H 'a: b' api.example.com/v1/follow -d '{}'")).toEqual(["api.example.com"]);
    expect(hostsFromCommand("wget -q shop.myshopify.com:443/x")).toEqual(["shop.myshopify.com"]);
    expect(hostsFromCommand("curl --data-binary @file.json -o out.json")).toEqual([]);
    expect(hostsFromCommand("curl -o page.html -H x api.example.com/a")).toEqual(["api.example.com"]);
    expect(hostsFromCommand("curl -d @payload.json --url api.example.com/x")).toEqual(["api.example.com"]);
    expect(hostsFromCommand("wget -O out.tgz files.example.org/a.tgz")).toEqual(["files.example.org"]);
  });
  it("is empty for local commands", () => {
    expect(hostsFromCommand("ls -la && npm test")).toEqual([]);
    expect(hostsFromCommand("")).toEqual([]);
    expect(hostsFromCommand(undefined)).toEqual([]);
  });
});

describe("hostsFromObject", () => {
  it("looks at URL-ish keys and nested objects", () => {
    expect(hostsFromObject({ url: "https://a.com/x", nested: { endpoint: "https://b.com" }, other: "https://ignored.com" })).toEqual([
      "a.com",
      "b.com",
    ]);
    expect(hostsFromObject({ host: "c.example.com", port: 443 })).toEqual(["c.example.com"]);
    expect(hostsFromObject({ urls: ["https://d.com", "https://e.com"] }).sort()).toEqual(["d.com", "e.com"]);
    expect(hostsFromObject(null)).toEqual([]);
    expect(hostsFromObject("https://plain.com")).toEqual(["plain.com"]);
  });
});

describe("read-only detection", () => {
  it("knows the read-only chrome tools and computer actions", () => {
    expect(isReadOnlyTool("mcp__claude-in-chrome__screenshot", {}, DEFAULT_READ_ONLY_TOOLS)).toBe(true);
    expect(isReadOnlyTool("mcp__claude-in-chrome__computer", { action: "screenshot" }, DEFAULT_READ_ONLY_TOOLS)).toBe(true);
    expect(isReadOnlyTool("mcp__claude-in-chrome__computer", { action: "left_click", tabId: 1 }, DEFAULT_READ_ONLY_TOOLS)).toBe(false);
    expect(isReadOnlyTool("WebFetch", {}, DEFAULT_READ_ONLY_TOOLS)).toBe(false);
  });
});

describe("resolveTargets", () => {
  const ro = DEFAULT_READ_ONLY_TOOLS;
  it("WebFetch → host", () => {
    expect(resolveTargets({ tool_name: "WebFetch", tool_input: { url: "https://api.github.com/x" } }, {}, ro)).toEqual({
      hosts: ["api.github.com"],
      readOnly: false,
    });
  });
  it("Bash → hosts in command, none for ls", () => {
    expect(resolveTargets({ tool_name: "Bash", tool_input: { command: "ls" } }, {}, ro)).toEqual({ hosts: [], readOnly: false });
    expect(resolveTargets({ tool_name: "Bash", tool_input: { command: "gh pr list" } }, {}, ro).hosts).toEqual(["api.github.com"]);
  });
  it("navigate → url host (and ignores the tab)", () => {
    const r = resolveTargets({ tool_name: "mcp__claude-in-chrome__navigate", tool_input: { url: "https://x.example.com", tabId: 7 } }, {}, ro);
    expect(r).toEqual({ hosts: ["x.example.com"], readOnly: false });
  });
  it("click on a known tab → that tab's host", () => {
    const tabs = { "7": { host: "x.example.com", updatedAt: 1 } };
    const r = resolveTargets({ tool_name: "mcp__claude-in-chrome__computer", tool_input: { action: "left_click", tabId: 7 } }, tabs, ro);
    expect(r).toEqual({ hosts: ["x.example.com"], readOnly: false });
  });
  it("click on an unknown tab → unknownTab", () => {
    const r = resolveTargets({ tool_name: "mcp__claude-in-chrome__form_input", tool_input: { tabId: "9", ref: "a" } }, {}, ro);
    expect(r).toEqual({ hosts: [], unknownTab: "9", readOnly: false });
  });
  it("read-only tools short-circuit", () => {
    expect(resolveTargets({ tool_name: "mcp__claude-in-chrome__get_page_text", tool_input: { tabId: 1 } }, {}, ro)).toEqual({ hosts: [], readOnly: true });
  });
  it("other MCP tools → any url in input", () => {
    expect(resolveTargets({ tool_name: "mcp__Exa__web_fetch_exa", tool_input: { url: "https://docs.foo.io/a" } }, {}, ro).hosts).toEqual(["docs.foo.io"]);
  });
});

describe("unpaceable", () => {
  it("counts fetch( calls like Rulestack", () => {
    expect(countFetchCalls("fetch('/a'); fetch('/b')")).toBe(2);
    expect(countFetchCalls("window.fetch('/a'); fetch('/b')")).toBe(1);
    expect(countFetchCalls("const x = prefetch('/a')")).toBe(0);
    expect(countFetchCalls("fetch ('/a')\nawait fetch(url)")).toBe(2);
  });
  it("refuses browser_batch and multi-fetch scripts", () => {
    expect(unpaceableReason("mcp__claude-in-chrome__browser_batch", {})).toMatch(/browser_batch/);
    expect(unpaceableReason("mcp__claude-in-chrome__javascript_tool", { text: "fetch(a); fetch(b)" })).toMatch(/2 fetch/);
    expect(unpaceableReason("mcp__claude-in-chrome__javascript_tool", { text: "fetch(a)" })).toBeUndefined();
    expect(unpaceableReason("WebFetch", {})).toBeUndefined();
  });
});

describe("tabsFromResponse", () => {
  it("reads structured tab lists", () => {
    expect(tabsFromResponse({ tabs: [{ id: 12, url: "https://x.example.com/a" }, { tabId: "13", url: "https://api.github.com" }] })).toEqual({
      "12": { host: "x.example.com", url: "https://x.example.com/a" },
      "13": { host: "api.github.com", url: "https://api.github.com" },
    });
  });
  it("reads MCP text content, including embedded JSON", () => {
    const content = [{ type: "text", text: JSON.stringify({ tabs: [{ id: 5, url: "https://shop.myshopify.com/admin" }] }) }];
    expect(tabsFromResponse(content)).toEqual({ "5": { host: "shop.myshopify.com", url: "https://shop.myshopify.com/admin" } });
  });
  it("reads loose text lines", () => {
    const text = "Navigation completed.\nOpen tabs:\n- Tab 21: Example (https://www.example.com/feed)\n- tabId 22 — https://b.test/x\nurl https://c.test/ for tab 23";
    expect(tabsFromResponse(text)).toEqual({
      "21": { host: "www.example.com", url: "https://www.example.com/feed)" .replace(")", "") },
      "22": { host: "b.test", url: "https://b.test/x" },
      "23": { host: "c.test", url: "https://c.test/" },
    });
  });
  it("ignores junk", () => {
    expect(tabsFromResponse(null)).toEqual({});
    expect(tabsFromResponse("no tabs here")).toEqual({});
    expect(tabsFromResponse({ id: 1 })).toEqual({});
  });
});
