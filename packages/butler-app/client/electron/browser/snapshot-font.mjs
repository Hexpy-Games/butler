import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

/** Subset off the Electron main thread; keep shaping, hinting and the full variation space. */
export async function subsetSnapshotFont(body, chars) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { body, chars } });
  try {
    return await new Promise((resolve, reject) => {
      worker.once("message", bytes => resolve(Buffer.from(bytes)));
      worker.once("error", reject);
      worker.once("exit", () => reject(new Error("snapshot_font_worker_exited")));
    });
  } finally { await worker.terminate(); }
}

if (!isMainThread) {
  const { default: subsetFont } = await import("subset-font");
  const bytes = await subsetFont(Buffer.from(workerData.body), workerData.chars, { targetFormat: "woff2" });
  parentPort.postMessage(bytes);
}
