import { describe, expect, it } from "vitest";
import { DEFAULT_READ_ONLY_TOOLS, hostMatches, mergeConfigs, refuseFor, rulesForHost, validatePartial } from "../src/config.js";

describe("hostMatches", () => {
  it("matches exact hosts case-insensitively", () => {
    expect(hostMatches("api.github.com", "API.GitHub.com")).toBe(true);
    expect(hostMatches("api.github.com", "github.com")).toBe(false);
  });
  it("matches wildcards across dots and the bare domain", () => {
    expect(hostMatches("*.example.com", "www.example.com")).toBe(true);
    expect(hostMatches("*.example.com", "a.b.example.com")).toBe(true);
    expect(hostMatches("*.example.com", "example.com")).toBe(true);
    expect(hostMatches("*.example.com", "notexample.com")).toBe(false);
    expect(hostMatches("*.example.com", "example.com.evil.net")).toBe(false);
  });
  it("supports ? and escapes regex chars", () => {
    expect(hostMatches("shop?.test", "shop1.test")).toBe(true);
    expect(hostMatches("shop?.test", "shop12.test")).toBe(false);
    expect(hostMatches("a.b", "aXb")).toBe(false);
    expect(hostMatches("*", "anything.at.all")).toBe(true);
  });
});

describe("validatePartial", () => {
  it("accepts the documented example", () => {
    const p = validatePartial(
      {
        defaultMinIntervalMs: 0,
        unknownTargetPolicy: "pace-all",
        inFlightHoldMs: 120000,
        readOnlyTools: ["x"],
        rules: [
          { name: "social", target: "*.example.com", minIntervalMs: 10000 },
          { name: "shops", target: ["*.myshopify.com", "shopify.com"], minIntervalMs: 2000, perHost: true, maxPerHour: 100 },
        ],
        refuse: [{ tool: "mcp__claude-in-chrome__browser_batch", reason: "no" }],
      },
      "f",
    );
    expect(p.rules?.length).toBe(2);
    expect(p.refuse?.[0]?.tool).toBe("mcp__claude-in-chrome__browser_batch");
  });
  it.each([
    [{ rules: [{ name: "a", target: "x", minIntervalMs: -1 }] }, /minIntervalMs/],
    [{ rules: [{ target: "x", minIntervalMs: 1 }] }, /name is required/],
    [{ rules: [{ name: "a", minIntervalMs: 1 }] }, /target/],
    [{ rules: [{ name: "a", target: "x", minIntervalMs: 1 }, { name: "a", target: "y", minIntervalMs: 1 }] }, /duplicate rule name/],
    [{ rules: [{ name: "a", target: "x", minIntervalMs: 1, bogus: 1 }] }, /unknown key "bogus"/],
    [{ unknownTargetPolicy: "maybe" }, /unknownTargetPolicy/],
    [{ nope: true }, /unknown key "nope"/],
    [[], /top level/],
    [{ refuse: [{ reason: "x" }] }, /refuse\[0\]\.tool/],
    [{ rules: [{ name: "a", target: "x", minIntervalMs: 1, maxPerHour: 0 }] }, /maxPerHour/],
  ])("rejects %j", (raw, re) => {
    expect(() => validatePartial(raw, "f")).toThrow(re);
  });
  it("allows $schema", () => {
    expect(validatePartial({ $schema: "x" }, "f")).toEqual({});
  });
});

describe("mergeConfigs", () => {
  it("overrides scalars, merges rules by name, refuse by tool, unions readOnlyTools", () => {
    const cfg = mergeConfigs([
      {
        defaultMinIntervalMs: 500,
        rules: [
          { name: "a", target: "a.com", minIntervalMs: 1 },
          { name: "b", target: "b.com", minIntervalMs: 2 },
        ],
        refuse: [{ tool: "t1", reason: "r1" }],
        readOnlyTools: ["ro1"],
      },
      {
        unknownTargetPolicy: "ignore",
        rules: [{ name: "b", target: "b2.com", minIntervalMs: 20 }, { name: "c", target: "c.com", minIntervalMs: 3 }],
        refuse: [{ tool: "t1", reason: "r1b" }, { tool: "t2" }],
        readOnlyTools: ["ro2"],
      },
    ]);
    expect(cfg.defaultMinIntervalMs).toBe(500);
    expect(cfg.unknownTargetPolicy).toBe("ignore");
    expect(cfg.rules.map((r) => `${r.name}:${r.target}:${r.minIntervalMs}`)).toEqual(["a:a.com:1", "b:b2.com:20", "c:c.com:3"]);
    expect(cfg.refuse).toEqual([{ tool: "t1", reason: "r1b" }, { tool: "t2" }]);
    expect(cfg.readOnlyTools).toEqual([...DEFAULT_READ_ONLY_TOOLS, "ro1", "ro2"]);
    expect(cfg.inFlightHoldMs).toBe(120_000);
  });
  it("with no layers equals the defaults", () => {
    const cfg = mergeConfigs([]);
    expect(cfg.rules).toEqual([]);
    expect(cfg.defaultMinIntervalMs).toBe(0);
    expect(cfg.unknownTargetPolicy).toBe("pace-all");
  });
});

describe("lookups", () => {
  const cfg = mergeConfigs([
    {
      rules: [
        { name: "social", target: "*.example.com", minIntervalMs: 10000 },
        { name: "gh", target: "api.github.com", minIntervalMs: 1000 },
        { name: "wide", target: "*", minIntervalMs: 1 },
      ],
      refuse: [{ tool: "mcp__claude-in-chrome__browser_batch" }, { tool: "mcp__evil__*" }],
    },
  ]);
  it("finds every rule for a host", () => {
    expect(rulesForHost(cfg, "www.example.com").map((r) => r.name)).toEqual(["social", "wide"]);
    expect(rulesForHost(cfg, "api.github.com").map((r) => r.name)).toEqual(["gh", "wide"]);
  });
  it("matches refuse rules exactly or by glob", () => {
    expect(refuseFor(cfg, "mcp__claude-in-chrome__browser_batch")?.tool).toBe("mcp__claude-in-chrome__browser_batch");
    expect(refuseFor(cfg, "mcp__evil__anything")?.tool).toBe("mcp__evil__*");
    expect(refuseFor(cfg, "WebFetch")).toBeUndefined();
  });
});
