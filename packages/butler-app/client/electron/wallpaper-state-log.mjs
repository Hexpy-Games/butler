import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Only the renderer diagnostics shape: short enum fields, never content. */
const LINE = /^wallpaper_state( [a-z]+=[a-z0-9_-]{1,24}){1,5}$/u;
export const WALLPAPER_STATE_SESSION_CAP = 200;
/** A file past this at the first line of a session moves to `.1` (one previous file kept). */
const ROLL_BYTES = 256 * 1024;

/**
 * The wallpaper run-state log: `<data>/app/logs/wallpaper-state.log`, also echoed to the main console (the
 * Electron log when one is enabled). Lines arrive only on transitions; one serialized appender, no timer, no
 * startup write, at most WALLPAPER_STATE_SESSION_CAP lines per App session.
 */
export function createWallpaperStateLog(dataRoot, { now = () => new Date(), echo = (line) => console.info(line) } = {}) {
  const path = join(dataRoot, "app", "logs", "wallpaper-state.log");
  let lines = 0;
  let prepared = false;
  let pending = Promise.resolve();
  return {
    path,
    record(line) {
      if (typeof line !== "string" || !LINE.test(line) || lines >= WALLPAPER_STATE_SESSION_CAP) return false;
      lines += 1;
      const entry = `${now().toISOString()} ${line}`;
      echo(entry);
      pending = pending.then(async () => {
        if (!prepared) {
          prepared = true;
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          const size = await stat(path).then((info) => info.size, () => 0);
          if (size > ROLL_BYTES) await rename(path, `${path}.1`);
        }
        await appendFile(path, `${entry}\n`, { mode: 0o600 });
      }).catch(() => {});
      return true;
    },
    flushed: () => pending,
  };
}
