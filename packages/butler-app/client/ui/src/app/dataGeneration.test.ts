// test-category: pure-logic
import { expect, test } from "bun:test";
import { DATA_GENERATION_STORAGE_KEY, reconcileDataGeneration } from "./dataGeneration.ts";

function memoryStorage(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return {
    get length() { return map.size; },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    entries: () => Object.fromEntries(map),
  };
}

test("a first generation is recorded without touching storage", () => {
  const storage = memoryStorage({ "butler:settings:v1": "{}" });
  expect(reconcileDataGeneration(storage, "g1")).toBe("recorded");
  expect(storage.entries()).toEqual({ "butler:settings:v1": "{}", [DATA_GENERATION_STORAGE_KEY]: "g1" });
  expect(reconcileDataGeneration(storage, "g1")).toBe("same");
  expect(reconcileDataGeneration(storage, undefined)).toBe("unknown");
});

test("a new generation removes every butler entry and keeps others", () => {
  const storage = memoryStorage({
    [DATA_GENERATION_STORAGE_KEY]: "g1",
    "butler:first-run-setup:v1": "{}",
    "butler:message-cache:v1:abc": "{}",
    "butler:composer-draft:v1:abc": "{}",
    "other:key": "kept",
  });
  const session = memoryStorage({ "butler:app-ui-state:v1": "{}", "other": "kept" });
  expect(reconcileDataGeneration(storage, "g2", [session])).toBe("wiped");
  expect(storage.entries()).toEqual({ "other:key": "kept", [DATA_GENERATION_STORAGE_KEY]: "g2" });
  expect(session.entries()).toEqual({ other: "kept" });
});
