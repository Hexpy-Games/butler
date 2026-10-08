import { watch } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";

// Startup only: one initial probe, then changes drive reads of the small record.
export function watchStorageCorrection(dataRoot, onProgress) {
  const directory = join(dataRoot, "agent-runtime");
  const path = join(directory, "storage-correction.json");
  let closed = false;
  let watcher;
  let parentWatcher;
  let deadline = 0;
  async function check() {
    try {
      if ((await stat(path)).size > 4096) return;
      const progress = JSON.parse(await readFile(path, "utf8"));
      const time = Date.parse(progress.deadlineAt);
      if (closed || progress.schema !== "butler.storage-correction-progress.v1" || !Number.isFinite(time)) return;
      deadline = time + 30_000;
      onProgress(deadline);
    } catch { /* The record appears and disappears during startup. */ }
  }
  function observe() {
    if (closed || watcher) return;
    try {
      watcher = watch(directory, (_event, name) => {
        if (name === "storage-correction.json") void check();
      });
      watcher.on("error", () => {});
      parentWatcher?.close(); parentWatcher = null;
      void check();
    } catch { /* A fresh installation has not made agent-runtime yet. */ }
  }
  try { parentWatcher = watch(dataRoot, observe); parentWatcher.on("error", () => {}); } catch { /* No data yet. */ }
  observe();
  return { deadline: () => deadline, close() { closed = true; watcher?.close(); parentWatcher?.close(); } };
}
