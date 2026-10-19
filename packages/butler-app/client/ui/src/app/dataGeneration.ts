/** The agent data generation this renderer's storage belongs to. */
export const DATA_GENERATION_STORAGE_KEY = "butler:data-generation:v1";
const BUTLER_STORAGE_PREFIX = "butler:";

type KeyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/**
 * Compares the agent's data generation with the one this storage last saw.
 * A first sighting is only recorded; a different one means the agent was
 * reset, so every `butler:*` entry from the old data is removed first.
 */
export function reconcileDataGeneration(
  storage: KeyStorage,
  generation: string | null | undefined,
  others: KeyStorage[] = [],
): "unknown" | "same" | "recorded" | "wiped" {
  if (typeof generation !== "string" || !generation) return "unknown";
  const recorded = storage.getItem(DATA_GENERATION_STORAGE_KEY);
  if (recorded === generation) return "same";
  if (recorded) for (const target of [storage, ...others]) removeButlerEntries(target);
  storage.setItem(DATA_GENERATION_STORAGE_KEY, generation);
  return recorded ? "wiped" : "recorded";
}

function removeButlerEntries(storage: KeyStorage): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(BUTLER_STORAGE_PREFIX)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}
