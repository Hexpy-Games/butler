/// <reference types="bun" />

import { expect, test } from "bun:test";
import { EMPTY_SETTINGS } from "@/app/constants.ts";
import type { SettingsView, TimelineEvent } from "@/app/types.ts";
import type { WallpaperSetting } from "@/butler-ds";
import { noteSettingsSnapshotRequest, settingsFromLiveEvent } from "./liveSettingsSync.ts";

const current: SettingsView = { ...EMPTY_SETTINGS, model: "local/stub", server_url: "http://127.0.0.1:19999" };
const silk: WallpaperSetting = {
  source: { kind: "live", module: "butler.silk" },
  motion: "paused",
  pauseOnBattery: true,
};

function settingsUpdated(settings: unknown, createdAt?: string): TimelineEvent {
  return { id: 7, type: "settings.updated", ...(createdAt ? { created_at: createdAt } : {}), payload: { settings } } as TimelineEvent;
}

test("settings.updated merges its fields over the current settings", () => {
  const next = settingsFromLiveEvent(
    current,
    settingsUpdated({ wallpaper: silk, appearance_theme: "dark", enabled_worker_profile_count: 2 }),
  );
  expect(next?.wallpaper).toEqual(silk);
  expect(next?.appearance_theme).toBe("dark");
  // Fields the event does not carry keep their current value.
  expect(next?.model).toBe("local/stub");
  expect(next?.server_url).toBe("http://127.0.0.1:19999");
  // Event-only counters are not settings.
  expect(next).not.toHaveProperty("enabled_worker_profile_count");
});

test("a malformed wallpaper in the event keeps a well-formed setting", () => {
  const next = settingsFromLiveEvent(
    { ...current, main_screen_theme: "silk" },
    settingsUpdated({ wallpaper: { source: { kind: "live" } } }),
  );
  expect(next?.wallpaper).toEqual({ source: { kind: "live", module: "butler.silk" }, motion: "auto", pauseOnBattery: false });
});

test("other events and payloads without settings change nothing", () => {
  expect(settingsFromLiveEvent(current, { type: "project.updated", payload: {} } as TimelineEvent)).toBeNull();
  expect(settingsFromLiveEvent(current, settingsUpdated(undefined))).toBeNull();
  expect(settingsFromLiveEvent(current, settingsUpdated(["wallpaper"]))).toBeNull();
});

const SNAPSHOT_AT = Date.parse("2026-09-28T10:00:00.000Z");

test("events created before the startup snapshot was requested are already in it", () => {
  // The stream replays from cursor 0 on load: an old wallpaper must not flash back.
  const replayed = settingsUpdated({ wallpaper: silk }, "2026-09-28T09:59:59.999Z");
  expect(settingsFromLiveEvent(current, replayed, SNAPSHOT_AT)).toBeNull();
  const live = settingsUpdated({ wallpaper: silk }, "2026-09-28T10:00:00.000Z");
  expect(settingsFromLiveEvent(current, live, SNAPSHOT_AT)?.wallpaper).toEqual(silk);
  expect(settingsFromLiveEvent(current, settingsUpdated({ wallpaper: silk }, "2026-09-28T10:00:03.000Z"), SNAPSHOT_AT)?.wallpaper).toEqual(silk);
});

test("without a snapshot, or an event without a readable timestamp, the event applies", () => {
  const old = settingsUpdated({ wallpaper: silk }, "2026-09-28T09:00:00.000Z");
  expect(settingsFromLiveEvent(current, old, null)?.wallpaper).toEqual(silk);
  expect(settingsFromLiveEvent(current, settingsUpdated({ wallpaper: silk }), SNAPSHOT_AT)?.wallpaper).toEqual(silk);
  expect(settingsFromLiveEvent(current, settingsUpdated({ wallpaper: silk }, "not a date"), SNAPSHOT_AT)?.wallpaper).toEqual(silk);
});

test("the noted snapshot request fences events by default", () => {
  const old = settingsUpdated({ wallpaper: silk }, "2026-09-28T09:59:00.000Z");
  try {
    noteSettingsSnapshotRequest(SNAPSHOT_AT);
    expect(settingsFromLiveEvent(current, old)).toBeNull();
    // A later snapshot never moves the fence back.
    noteSettingsSnapshotRequest(SNAPSHOT_AT - 60_000);
    expect(settingsFromLiveEvent(current, old)).toBeNull();
  } finally {
    noteSettingsSnapshotRequest(null);
  }
  expect(settingsFromLiveEvent(current, old)?.wallpaper).toEqual(silk);
});
