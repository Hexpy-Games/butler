// test-category: pure-logic
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  composerDraftSnapshot,
  newestComposerDraft,
  normalizeComposerDraft,
  readCachedComposerDraft,
  readLocalComposerDraft,
  writeCachedComposerDraft,
  writeLocalComposerDraft,
} from "../../packages/butler-app/client/ui/src/app/composerDraftCache.ts";
import { APP_CACHE_BUDGET } from
  "../../packages/butler-app/client/ui/src/app/cacheBudget.ts";

// Restore descriptors, not just values: defining an absent global defaults to
// writable:false, which otherwise leaks into later files in Bun's shared VM.
const browserGlobals = ["localStorage", "window"] as const;
let savedGlobals: (PropertyDescriptor | undefined)[];

beforeEach(() => {
  savedGlobals = browserGlobals.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
});

afterEach(() => {
  browserGlobals.forEach((name, index) => {
    const descriptor = savedGlobals[index];
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  });
});

test("composer draft cache keeps exact sessions isolated including empty clears", () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });

  writeLocalComposerDraft(composerDraftSnapshot("session-a", "alpha"));
  writeLocalComposerDraft(composerDraftSnapshot("session-b", "beta"));
  writeLocalComposerDraft(composerDraftSnapshot("session-a", ""));

  expect(readLocalComposerDraft("session-a")?.text).toBe("");
  expect(readLocalComposerDraft("session-b")?.text).toBe("beta");
  expect(values.size).toBe(2);
});

test("composer draft cache chooses the newest valid snapshot without accepting another session", () => {
  const local = composerDraftSnapshot(
    "session-a",
    "local-newer",
    "2026-08-04T01:00:02.000Z",
  );
  const durable = composerDraftSnapshot(
    "session-a",
    "durable-older",
    "2026-08-04T01:00:01.000Z",
  );

  expect(newestComposerDraft(local, durable)).toEqual(local);
  expect(newestComposerDraft(local, { ...durable, updated_at: local.updated_at }))
    .toEqual(local);
  expect(normalizeComposerDraft({ ...local, session_id: "session-b" }, "session-a"))
    .toBeNull();
  expect(normalizeComposerDraft({ ...local, schema: "unknown" }, "session-a"))
    .toBeNull();
});

test("composer draft cache restores from Electron when the renderer origin is empty", async () => {
  let writtenSessionId = "";
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => undefined,
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      butlerApp: {
        readCachedComposerDraft: async ({ sessionId }: { sessionId: string }) =>
          composerDraftSnapshot(
            sessionId,
            "durable after origin change",
            "2026-08-04T01:00:03.000Z",
          ),
        writeCachedComposerDraft: async ({ snapshot }: {
          snapshot: { session_id: string };
        }) => {
          writtenSessionId = snapshot.session_id;
        },
      },
    },
  });

  expect((await readCachedComposerDraft("session-a"))?.text)
    .toBe("durable after origin change");
  writeLocalComposerDraft(composerDraftSnapshot("session-a", "next"));
  writeCachedComposerDraft("session-a", "next");
  await Promise.resolve();
  expect(writtenSessionId).toBe("session-a");
});

test("renderer draft storage bounds sessions and aggregate bytes while protecting current session", () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  for (let index = 0; index < APP_CACHE_BUDGET.maxComposerDraftEntries + 4; index += 1) {
    writeCachedComposerDraft(
      `session-${index}`,
      "x".repeat(60 * 1024),
    );
  }
  writeCachedComposerDraft("session-0", "active");
  expect(values.size).toBeLessThanOrEqual(APP_CACHE_BUDGET.maxComposerDraftEntries);
  const totalBytes = [...values.values()].reduce(
    (total, raw) => total + new TextEncoder().encode(raw).byteLength,
    0,
  );
  expect(totalBytes).toBeLessThanOrEqual(APP_CACHE_BUDGET.maxComposerDraftAggregateBytes);
  expect(readLocalComposerDraft("session-0")?.text).toBe("active");
  expect(writeCachedComposerDraft("oversized", "x".repeat(
    APP_CACHE_BUDGET.maxComposerDraftBytes + 1,
  ))).toBeNull();
  expect(readLocalComposerDraft("oversized")).toBeNull();
});
