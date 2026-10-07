// test-category: security
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { saveProjectWallpaper, type GatewayRequest } from "./projectWallpaperSave.ts";

const SILK = { kind: "live", module: "butler.silk" } as const;

type Call = { path: string; method: string; body?: unknown };

/**
 * A gateway double for one project's preferences: GET the dashboard (its
 * revision), PATCH preferences under the revision CAS. `bumps` moves the
 * revision behind the caller's back before that many PATCHes.
 */
function gateway({ revision = 4, bumps = 0, fail }: { revision?: number; bumps?: number; fail?: Error } = {}) {
  const calls: Call[] = [];
  let current = revision;
  let pendingBumps = bumps;
  const request: GatewayRequest = async (path, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) as { expectedRevision: number } : undefined;
    calls.push({ path, method, ...(body ? { body } : {}) });
    if (method === "GET") return { preferences: { revision: current, pinnedSourceRefs: [] } } as never;
    if (fail) throw fail;
    if (pendingBumps > 0) {
      pendingBumps -= 1;
      current += 1;
    }
    if (body?.expectedRevision !== current) {
      // Codes do not survive the desktop bridge: only the message and the revision tell.
      throw new Error("Preferences changed. Reload them.");
    }
    current += 1;
    return { revision: current } as never;
  };
  return { calls, request };
}

test("PATCHes the wallpaper under the known revision and resolves the next one", async () => {
  const { calls, request } = gateway({ revision: 4 });
  expect(await saveProjectWallpaper("p 1", SILK, { revision: 4, request })).toBe(5);
  expect(calls).toEqual([
    { path: "/projects/p%201/dashboard/preferences", method: "PATCH", body: { expectedRevision: 4, wallpaper: SILK } },
  ]);
});

test("without a known revision, reads it first; inherit saves like a source", async () => {
  const { calls, request } = gateway({ revision: 9 });
  expect(await saveProjectWallpaper("p1", "inherit", { request })).toBe(10);
  expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /projects/p1/dashboard", "PATCH /projects/p1/dashboard/preferences"]);
  expect(calls[1]?.body).toEqual({ expectedRevision: 9, wallpaper: "inherit" });
});

test("a conflict (the revision moved) refetches it and retries once", async () => {
  const { calls, request } = gateway({ revision: 4, bumps: 1 });
  expect(await saveProjectWallpaper("p1", SILK, { revision: 4, request })).toBe(6);
  expect(calls.map((call) => `${call.method} ${String((call.body as { expectedRevision?: number } | undefined)?.expectedRevision ?? "")}`)).toEqual([
    "PATCH 4", "GET ", "PATCH 5",
  ]);
});

test("a second conflict gives up: one retry only", async () => {
  const { calls, request } = gateway({ revision: 4, bumps: 2 });
  await expect(saveProjectWallpaper("p1", SILK, { revision: 4, request })).rejects.toThrow("Preferences changed");
  expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(2);
});

test("a failure that is not a conflict (the revision did not move) is not retried", async () => {
  const { calls, request } = gateway({ revision: 4, fail: new Error("Wallpaper image not found.") });
  await expect(saveProjectWallpaper("p1", SILK, { revision: 4, request })).rejects.toThrow("Wallpaper image not found.");
  expect(calls.map((call) => call.method)).toEqual(["PATCH", "GET"]);
});
