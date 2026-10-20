import os from "node:os";
import path from "node:path";

export type Env = Record<string, string | undefined>;

/**
 * Where machine-wide state lives. This is deliberately NOT derived from
 * `CLAUDE_PLUGIN_DATA`: the `paceline` CLI, `paceline run` from your own
 * scripts, and hooks loaded through different plugin install paths
 * (marketplace, `--plugin-dir`, skills-dir) must all land on the same
 * directory or they would not share one throttle. `~/.cache/paceline` is
 * stable across plugin updates, which is the property `CLAUDE_PLUGIN_DATA`
 * would otherwise buy us.
 */
export function stateDir(env: Env = process.env): string {
  if (env.PACELINE_STATE_DIR) return path.resolve(env.PACELINE_STATE_DIR);
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, "paceline");
  if (process.platform === "win32" && env.LOCALAPPDATA) {
    return path.join(env.LOCALAPPDATA, "paceline");
  }
  return path.join(os.homedir(), ".cache", "paceline");
}

export function userConfigPath(env: Env = process.env): string {
  if (env.PACELINE_CONFIG) return path.resolve(env.PACELINE_CONFIG);
  const claudeHome = env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return path.join(claudeHome, "paceline.json");
}

export function projectConfigPath(projectDir: string): string {
  return path.join(projectDir, ".claude", "paceline.json");
}

/** The project root for per-project config: CLAUDE_PROJECT_DIR, else the hook's cwd. */
export function projectDir(hookCwd: string | undefined, env: Env = process.env): string | undefined {
  if (env.PACELINE_NO_PROJECT_CONFIG) return undefined;
  return env.CLAUDE_PROJECT_DIR ?? hookCwd;
}
