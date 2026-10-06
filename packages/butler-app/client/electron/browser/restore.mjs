import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { webUrl } from "./policy.mjs";

/** Change-only persistence; no interval, and never persist output capabilities. */
export function createTabRestore(directory, snapshot) {
  const path = join(directory, "browser-tabs.json");
  let timer;
  let dirty = false;
  let writing = Promise.resolve();
  function flush() {
    clearTimeout(timer);
    if (!dirty) return writing;
    dirty = false;
    const data = JSON.stringify(snapshot());
    writing = writing.catch(() => {}).then(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(`${path}.tmp`, data, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
    return writing;
  }
  return {
    async read() {
      try {
        const data = JSON.parse(await readFile(path, "utf8"));
        return Array.isArray(data) ? data.filter((url) => url === "" || webUrl(url)) : [];
      } catch { return []; }
    },
    changed() { dirty = true; clearTimeout(timer); timer = setTimeout(() => void flush().catch(() => {}), 2000); },
    flush,
  };
}
