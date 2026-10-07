import { mkdir, open, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appendCrash, CRASH_LOG_BYTES } from "./ui-crash-log.mjs";

/** One serialized writer, no timer, no startup write; survives renderer reloads. */
export function createUiCrashStore(dataRoot, getVersion) {
  const path = join(dataRoot, "app", "logs", "ui-crashes.json");
  let pending = Promise.resolve();
  async function read() {
    try {
      const file = await open(path, "r");
      try {
        if ((await file.stat()).size >= CRASH_LOG_BYTES) return [];
        const entries = JSON.parse(await file.readFile("utf8"));
        return Array.isArray(entries) ? entries.slice(-50) : [];
      } finally { await file.close(); }
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return [];
      throw error;
    }
  }
  return {
    path,
    async read() { await pending; return read(); },
    append(input) {
      const result = pending.then(async () => {
        const entries = appendCrash(await read(), input, getVersion());
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.tmp`;
        const file = await open(temporary, "w", 0o600);
        try { await file.writeFile(JSON.stringify(entries)); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, path);
        return { ok: true };
      });
      pending = result.catch(() => {});
      return result;
    },
  };
}
