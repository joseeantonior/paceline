// Sets the same version everywhere: npm run bump -- 0.1.1
import { execSync } from "node:child_process";
import fs from "node:fs";

const v = process.argv[2];
if (!v || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v)) {
  console.error("usage: npm run bump -- <semver>");
  process.exit(64);
}
execSync(`npm version ${v} --no-git-tag-version --allow-same-version`, { stdio: "inherit" }); // package.json + lock
const pluginPath = ".claude-plugin/plugin.json";
const plugin = JSON.parse(fs.readFileSync(pluginPath, "utf8"));
plugin.version = v;
fs.writeFileSync(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`);
const cliPath = "src/cli.ts";
fs.writeFileSync(cliPath, fs.readFileSync(cliPath, "utf8").replace(/const VERSION = "[^"]+"/, `const VERSION = "${v}"`));
console.log(`bumped to ${v}; now: npm run build && git commit -am "v${v}" && git tag v${v} && git push && git push --tags`);
