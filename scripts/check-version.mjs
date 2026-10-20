// Fails when the version is not identical in package.json, the plugin manifest, and the CLI.
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const plugin = JSON.parse(fs.readFileSync(".claude-plugin/plugin.json", "utf8")).version;
const cliSrc = /const VERSION = "([^"]+)"/.exec(fs.readFileSync("src/cli.ts", "utf8"))?.[1];
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const lockVersions = [lock.version, lock.packages?.[""]?.version];

const all = { "package.json": pkg, ".claude-plugin/plugin.json": plugin, "src/cli.ts": cliSrc, "package-lock.json": lockVersions.join("/") };
const bad = Object.entries(all).filter(([, v]) => v !== pkg && v !== `${pkg}/${pkg}`);
if (bad.length) {
  console.error(`version mismatch: package.json is ${pkg}, but ${bad.map(([f, v]) => `${f} is ${v}`).join(", ")}`);
  console.error("Run: npm run bump -- <version>");
  process.exit(1);
}
console.log(`version ${pkg} consistent`);
