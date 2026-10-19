import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FULL_RESET_PENDING_FILE } from "./app-full-reset.mjs";

/** userData record of the Agent data generation the renderer storage belongs to. */
export const DATA_GENERATION_FILE = "butler-data-generation.json";
const SCHEMA = "butler.app.data-generation.v1";

export async function readRecordedDataGeneration(userDataPath) {
  const record = await readJson(join(userDataPath, DATA_GENERATION_FILE));
  return record?.schema === SCHEMA && typeof record.data_generation === "string" ? record.data_generation : null;
}

/**
 * Runs before the window opens. A first sighting is only recorded; a
 * different generation means the data folder was reset (by this App or
 * another client), so renderer storage from the old data is cleared. A
 * pending reset whose generation did not change kept the old data: the
 * caller reports it as failed.
 */
export async function reconcileAppDataGeneration({ userDataPath, readGeneration, clearRendererStorage }) {
  const generation = await readGeneration().catch(() => null);
  if (typeof generation !== "string" || !generation) return { outcome: "unknown", resetFailed: false };
  const pendingPath = join(userDataPath, FULL_RESET_PENDING_FILE);
  const pending = await readJson(pendingPath);
  const resetFailed = pending?.previous_data_generation === generation;
  const recorded = await readRecordedDataGeneration(userDataPath);
  if (recorded && recorded !== generation) await clearRendererStorage();
  if (recorded !== generation) {
    await writeFile(join(userDataPath, DATA_GENERATION_FILE),
      `${JSON.stringify({ schema: SCHEMA, data_generation: generation })}\n`, { mode: 0o600 });
  }
  if (pending) await rm(pendingPath, { force: true });
  return { outcome: !recorded ? "recorded" : recorded === generation ? "same" : "cleared", resetFailed };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
