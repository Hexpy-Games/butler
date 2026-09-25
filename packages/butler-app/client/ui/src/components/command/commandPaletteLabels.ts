import { appCopy, type AppCopy } from "@/app/copy.ts";
import type { CommandPaletteResult } from "@/app/types.ts";

type KindLabels = AppCopy["commandPalette"]["kindLabels"];

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
  const subtitle = result.subtitle?.trim();
  if (!subtitle || subtitle === SERVER_KIND_SUBTITLES[result.kind]) return labels[result.kind];
  return subtitle;
}
