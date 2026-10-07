// test-category: security
/// <reference types="bun" />
import { expect, test } from "bun:test";
import type { WallpaperSetting } from "@/butler-ds";
import type {
  ProjectDashboardPreferences,
  ProjectDashboardPreferencesPatch,
  ProjectSummary,
  ProjectWallpaper,
} from "./types.ts";
import { resolveWallpaper } from "./projectWallpaper.ts";

const GLOBAL: WallpaperSetting = {
  source: { kind: "live", module: "butler.bloom", params: { colors: "aurora" } },
  motion: "paused",
  pauseOnBattery: true,
};
const SILK = { kind: "live", module: "butler.silk", params: { base: "#223344" } } as const;

function project(wallpaper?: ProjectWallpaper): ProjectSummary {
  return {
    id: "p1",
    display_name: "Demo",
    last_activity_at: "2026-09-28T00:00:00.000Z",
    pinned: false,
    archived: false,
    ...(wallpaper === undefined ? {} : { wallpaper }),
  };
}

test("outside a project, or when the project inherits, the global wallpaper applies as is", () => {
  expect(resolveWallpaper(GLOBAL)).toBe(GLOBAL);
  expect(resolveWallpaper(GLOBAL, null)).toBe(GLOBAL);
  expect(resolveWallpaper(GLOBAL, project("inherit"))).toBe(GLOBAL);
  // Older gateways and optimistic rows carry no wallpaper: inherit.
  expect(resolveWallpaper(GLOBAL, project())).toBe(GLOBAL);
});

test("a project's own source wins; motion and battery preferences stay global", () => {
  expect(resolveWallpaper(GLOBAL, project(SILK))).toEqual({ source: SILK, motion: "paused", pauseOnBattery: true });
  const off: WallpaperSetting = { source: { kind: "none" }, motion: "auto", pauseOnBattery: false };
  expect(resolveWallpaper(off, project(SILK))).toEqual({ source: SILK, motion: "auto", pauseOnBattery: false });
});

test("a project can turn the wallpaper off while the global one is on", () => {
  expect(resolveWallpaper(GLOBAL, project({ kind: "none" }))).toEqual({ ...GLOBAL, source: { kind: "none" } });
});

test("a malformed project value falls back to the global wallpaper", () => {
  for (const bad of [{ kind: "live" }, { kind: "sparkle" }, { kind: "image", asset: "a1" }, "global", 42, null]) {
    expect(resolveWallpaper(GLOBAL, project(bad as unknown as ProjectWallpaper))).toBe(GLOBAL);
  }
});

test("project summaries and dashboard preferences carry the project wallpaper as the gateway sends it", () => {
  const summary = { ...project(), wallpaper: "inherit" } satisfies ProjectSummary;
  const preferences = {
    revision: 3,
    pinnedSourceRefs: [],
    wallpaper: { kind: "image", asset: "a1", fit: "cover", dim: 0.2, blur: 0 },
  } satisfies ProjectDashboardPreferences;
  const patch = { expectedRevision: 3, wallpaper: SILK } satisfies ProjectDashboardPreferencesPatch;
  // @ts-expect-error a project wallpaper is "inherit" or a wallpaper source
  const invalid: ProjectWallpaper = "global";
  expect<unknown[]>([summary.wallpaper, preferences.wallpaper.kind, patch.wallpaper.module, invalid]).toEqual([
    "inherit",
    "image",
    "butler.silk",
    "global",
  ]);
});
