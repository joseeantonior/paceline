import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  logLevel: "info",
};

await build({
  ...shared,
  entryPoints: ["src/hook.ts"],
  outfile: "dist/hook.js",
  banner: { js: "#!/usr/bin/env node" },
});

await build({
  ...shared,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  banner: { js: "#!/usr/bin/env node" },
});
