import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { saveProjectWallpaper, type GatewayRequest } from "@/app/projectWallpaperSave.ts";
import type { ProjectWallpaper, SettingsView, TimelineEvent } from "@/app/types.ts";
import { parseWallpaperSource } from "@/app/wallpaperSetting.ts";
import type { WallpaperSource } from "@/butler-ds";
import { predatesSettingsSnapshot } from "./liveSettingsSync.ts";

/** An agent's wallpaper change, and what Undo restores. */
export type WallpaperChange =
  | { scope: "global"; previous: WallpaperSource; next: WallpaperSource }
  | { scope: "project"; projectId: string; previous: ProjectWallpaper };

/** Older changes are history (a reconnect's replay), not something the user just saw happen. */
const RECENT_MS = 60_000;
const TOAST_ID = "wallpaper-changed";

type UnknownRecord = Record<string, unknown>;

/**
 * A `wallpaper.changed` event the agent caused (`origin: "agent"`), with the
 * wallpaper to restore; null for the user's own changes, other events,
 * malformed payloads, and history: events older than the settings snapshot
 * (the stream replays from cursor 0 on load) or than a minute.
 */
export function agentWallpaperChange(
  event: TimelineEvent,
  now = Date.now(),
  snapshotAt?: number | null,
): WallpaperChange | null {
  if (event.type !== "wallpaper.changed") return null;
  const payload = (event.payload ?? {}) as UnknownRecord;
  if (payload.origin !== "agent" || predatesSettingsSnapshot(event, snapshotAt)) return null;
  const createdAt = Date.parse(event.created_at ?? "");
  if (Number.isFinite(createdAt) && now - createdAt > RECENT_MS) return null;
  if (payload.scope === "global") {
    const previous = parseWallpaperSource(payload.previous);
    const next = parseWallpaperSource(payload.next);
    return previous && next ? { scope: "global", previous, next } : null;
  }
  if (payload.scope !== "project" || typeof payload.projectId !== "string" || !payload.projectId) return null;
  const previous = payload.previous === "inherit" ? "inherit" : parseWallpaperSource(payload.previous);
  return previous ? { scope: "project", projectId: payload.projectId, previous } : null;
}

/** Structural equality of two JSON values, ignoring object key order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bRecord = b as UnknownRecord;
  return aKeys.length === Object.keys(b).length
    && aKeys.every((key) => key in bRecord && sameJson((a as UnknownRecord)[key], bRecord[key]));
}

/**
 * Restores the wallpaper before an agent's change: the global setting's
 * source (the saved settings go to `onSettings`), or the project's
 * preferences under their revision (CAS, one retry on conflict). A global
 * undo is skipped when the setting no longer shows the agent's `next`
 * (a newer edit won). Rejects when the write fails.
 */
export async function undoWallpaperChange(
  change: WallpaperChange,
  { request = api, onSettings }: { request?: GatewayRequest; onSettings?: (settings: SettingsView) => void } = {},
): Promise<void> {
  if (change.scope === "project") {
    await saveProjectWallpaper(change.projectId, change.previous, { request });
    return;
  }
  const current = await request<SettingsView>("/settings");
  if (!sameJson(current.wallpaper?.source, change.next)) return;
  const settings = await request<SettingsView>("/settings", {
    method: "PATCH",
    body: JSON.stringify({ wallpaper: { source: change.previous } }),
  });
  onSettings?.(settings);
}

/** A brief "Wallpaper changed" toast whose Undo runs `undo`; a failed undo is one brief error toast. */
export function notifyAgentWallpaperChange(change: WallpaperChange, undo: (change: WallpaperChange) => Promise<void>): void {
  const copy = appCopy.settings.wallpaper;
  notifyStatus(copy.changed, {
    id: TOAST_ID,
    action: {
      label: copy.undo,
      onClick: () => {
        undo(change).catch(() => notifyStatus(copy.undoFailed, { id: TOAST_ID, tone: "error" }));
      },
    },
  });
}
