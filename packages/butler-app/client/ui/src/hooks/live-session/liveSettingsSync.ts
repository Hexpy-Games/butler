import { EMPTY_SETTINGS } from "@/app/constants.ts";
import { settingsWithDefaults } from "@/app/settingsCache.ts";
import type { SettingsView, TimelineEvent } from "@/app/types.ts";

const SETTINGS_KEYS = new Set(Object.keys(EMPTY_SETTINGS));

let snapshotRequestedAt: number | null = null;

/**
 * The settings snapshot is being fetched (at startup): `settings.updated`
 * events created before `at` are already in it. The fence only moves
 * forward; null clears it.
 */
export function noteSettingsSnapshotRequest(at: number | null = Date.now()): void {
  snapshotRequestedAt = at === null ? null : Math.max(snapshotRequestedAt ?? at, at);
}

/**
 * The live stream replays past events on load (from cursor 0). An event
 * created (the gateway's `created_at`, on the same clock) before the settings
 * snapshot was requested is history the snapshot already holds.
 */
export function predatesSettingsSnapshot(event: TimelineEvent, snapshotAt: number | null = snapshotRequestedAt): boolean {
  const createdAt = Date.parse(event.created_at ?? "");
  return snapshotAt !== null && Number.isFinite(createdAt) && createdAt < snapshotAt;
}

/**
 * The settings after a `settings.updated` event (a change from the settings
 * screen, another window or the agent), or null for other events. The
 * event carries a subset of settings; fields it omits keep their value.
 * Replayed events that predate the snapshot are ignored, so stale settings
 * never flash back.
 */
export function settingsFromLiveEvent(
  current: SettingsView,
  event: TimelineEvent,
  snapshotAt: number | null = snapshotRequestedAt,
): SettingsView | null {
  if (event.type !== "settings.updated" || predatesSettingsSnapshot(event, snapshotAt)) return null;
  const changed = event.payload?.settings;
  if (!changed || typeof changed !== "object" || Array.isArray(changed)) return null;
  const patch = Object.fromEntries(Object.entries(changed).filter(([key]) => SETTINGS_KEYS.has(key)));
  return settingsWithDefaults({ ...current, ...patch });
}
