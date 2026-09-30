import { scheduleFrequency } from "@/app/scheduleLabels";
import { appCopy, type AppCopy } from "@/app/copy.ts";
import type { CommandPaletteResult } from "@/app/types.ts";

type KindLabels = AppCopy["commandPalette"]["kindLabels"];
type SettingsSections = AppCopy["commandPalette"]["settingsSections"];

/** Generic subtitles the app server uses when a result has no location. */
const SERVER_KIND_SUBTITLES: Partial<Record<CommandPaletteResult["kind"], string>> = {
  chat: "Chat",
  project_session: "Project chat",
  project: "Project",
  group: "스페이스",
  settings: "Settings",
};

export function commandResultSubtitle(
  result: CommandPaletteResult,
  labels: KindLabels = appCopy.commandPalette.kindLabels,
): string {
  if (result.kind === "automation" && (result.schedule || result.interval_seconds)) return scheduleFrequency(result);
  const subtitle = result.subtitle?.trim();
  if (!subtitle || subtitle === SERVER_KIND_SUBTITLES[result.kind]) return labels[result.kind];
  return subtitle;
}

/** Settings results carry an English section title; the id suffix is stable. */
export function commandResultTitle(
  result: CommandPaletteResult,
  sections: SettingsSections = appCopy.commandPalette.settingsSections,
): string {
  if (result.kind !== "settings" || !result.id.startsWith("settings:")) return result.title;
  return sections[result.id.slice("settings:".length)] ?? result.title;
}
