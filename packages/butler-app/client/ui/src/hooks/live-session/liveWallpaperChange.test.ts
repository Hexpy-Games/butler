// test-category: race
/// <reference types="bun" />
import { afterAll, expect, spyOn, test } from "bun:test";
import { toast } from "sonner";
import { getAppLocale, setAppCopyLanguage } from "@/app/copy.ts";
import type { TimelineEvent } from "@/app/types.ts";
import type { GatewayRequest } from "@/app/projectWallpaperSave.ts";
import {
  agentWallpaperChange,
  notifyAgentWallpaperChange,
  undoWallpaperChange,
  type WallpaperChange,
} from "./liveWallpaperChange.ts";

const initialLocale = getAppLocale();
afterAll(() => setAppCopyLanguage(initialLocale));

const NOW = Date.parse("2026-09-28T10:00:00.000Z");
const SILK = { kind: "live", module: "butler.silk" } as const;
const BLOOM = { kind: "live", module: "butler.bloom" } as const;

function changed(payload: Record<string, unknown>, createdAt = "2026-09-28T09:59:58.000Z"): TimelineEvent {
  return { id: 12, type: "wallpaper.changed", created_at: createdAt, payload } as unknown as TimelineEvent;
}

test("an agent's global or project change is offered for undo with its previous wallpaper", () => {
  expect(agentWallpaperChange(changed({ scope: "global", previous: SILK, next: BLOOM, origin: "agent" }), NOW, null)).toEqual({
    scope: "global", previous: SILK, next: BLOOM,
  });
  expect(agentWallpaperChange(changed({ scope: "project", projectId: "p1", previous: "inherit", next: SILK, origin: "agent" }), NOW, null)).toEqual({
    scope: "project", projectId: "p1", previous: "inherit",
  });
});

test("user changes, other events and malformed payloads are not offered", () => {
  expect(agentWallpaperChange(changed({ scope: "global", previous: SILK, next: BLOOM, origin: "user" }), NOW, null)).toBeNull();
  expect(agentWallpaperChange({ ...changed({ scope: "global", previous: SILK, origin: "agent" }), type: "settings.updated" }, NOW, null)).toBeNull();
  // The global wallpaper cannot inherit; a project change needs its project.
  expect(agentWallpaperChange(changed({ scope: "global", previous: "inherit", next: SILK, origin: "agent" }), NOW, null)).toBeNull();
  expect(agentWallpaperChange(changed({ scope: "project", previous: SILK, next: BLOOM, origin: "agent" }), NOW, null)).toBeNull();
  expect(agentWallpaperChange(changed({ scope: "global", previous: { kind: "live" }, next: BLOOM, origin: "agent" }), NOW, null)).toBeNull();
  expect(agentWallpaperChange(changed({ scope: "space", previous: SILK, next: BLOOM, origin: "agent" }), NOW, null)).toBeNull();
});

test("history replayed on load is not offered: older than the settings snapshot, or than a minute", () => {
  const event = changed({ scope: "global", previous: SILK, next: BLOOM, origin: "agent" }, "2026-09-28T09:59:58.000Z");
  expect(agentWallpaperChange(event, NOW, NOW - 1_000)).toBeNull();
  expect(agentWallpaperChange(event, NOW, NOW - 5_000)).not.toBeNull();
  expect(agentWallpaperChange(event, NOW + 61_000, null)).toBeNull();
});

test("undoing a global change PATCHes the settings source back only while the agent's wallpaper is still shown", async () => {
  const run = async (shown: unknown) => {
    const calls: Array<[string, string, unknown]> = [];
    const request: GatewayRequest = async (path, init) => {
      calls.push([path, init?.method ?? "GET", init?.body ? JSON.parse(init.body) : undefined]);
      return { wallpaper: { source: init?.method === "PATCH" ? SILK : shown, motion: "auto", pauseOnBattery: false } } as never;
    };
    const saved: unknown[] = [];
    await undoWallpaperChange({ scope: "global", previous: SILK, next: BLOOM }, { request, onSettings: (settings) => saved.push(settings) });
    return { calls, saved };
  };
  const fresh = await run({ module: "butler.bloom", kind: "live" });
  expect(fresh.calls).toEqual([["/settings", "GET", undefined], ["/settings", "PATCH", { wallpaper: { source: SILK } }]]);
  expect(fresh.saved).toEqual([{ wallpaper: { source: SILK, motion: "auto", pauseOnBattery: false } }]);
  // A newer edit replaced the agent's wallpaper: Undo does nothing.
  const stale = await run({ kind: "none" });
  expect(stale.calls).toEqual([["/settings", "GET", undefined]]);
  expect(stale.saved).toEqual([]);
});

test("undoing a project change restores it under the preferences revision", async () => {
  const calls: Array<[string, string | undefined, unknown]> = [];
  const request: GatewayRequest = async (path, init) => {
    calls.push([path, init?.method ?? "GET", init?.body ? JSON.parse(init.body) : undefined]);
    return (init?.method === "PATCH" ? { revision: 8 } : { preferences: { revision: 7, pinnedSourceRefs: [] } }) as never;
  };
  await undoWallpaperChange({ scope: "project", projectId: "p1", previous: "inherit" }, { request });
  expect(calls).toEqual([
    ["/projects/p1/dashboard", "GET", undefined],
    ["/projects/p1/dashboard/preferences", "PATCH", { expectedRevision: 7, wallpaper: "inherit" }],
  ]);
});

test("the toast says the wallpaper changed and its Undo restores it; a failed undo is one brief toast", async () => {
  setAppCopyLanguage("en");
  const message = spyOn(toast, "message");
  const error = spyOn(toast, "error");
  try {
    const change: WallpaperChange = { scope: "global", previous: SILK, next: BLOOM };
    const undone: WallpaperChange[] = [];
    notifyAgentWallpaperChange(change, async (value) => { undone.push(value); });
    expect(message).toHaveBeenCalledTimes(1);
    const [text, options] = message.mock.calls[0] as unknown as [string, { action: { label: string; onClick: () => void } }];
    expect(text).toBe("Wallpaper changed");
    expect(options.action.label).toBe("Undo");
    options.action.onClick();
    await Promise.resolve();
    expect(undone).toEqual([change]);
    expect(error).not.toHaveBeenCalled();

    notifyAgentWallpaperChange(change, async () => { throw new Error("offline"); });
    (message.mock.calls[1] as unknown as [string, { action: { onClick: () => void } }])[1].action.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(error.mock.calls.map(([text]) => text)).toEqual(["Couldn't undo."]);
  } finally {
    message.mockRestore();
    error.mockRestore();
  }
});
