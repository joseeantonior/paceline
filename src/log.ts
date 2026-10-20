import fs from "node:fs";
import path from "node:path";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Append one line to `<state>/paceline.log`. Hooks have no terminal and
 * their stderr is only visible under `claude --debug`, so this file is the
 * audit trail. Never throws.
 */
export function logLine(dir: string, message: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "paceline.log");
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_LOG_BYTES) fs.renameSync(file, file + ".1");
    } catch {
      /* no file yet */
    }
    fs.appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${message}\n`);
  } catch {
    /* logging must never break a hook */
  }
}
