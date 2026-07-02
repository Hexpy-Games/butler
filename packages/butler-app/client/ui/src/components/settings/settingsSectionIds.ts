import type { SettingsSectionId } from "../../app/types.ts";

const BASE_SETTINGS_SECTION_IDS: SettingsSectionId[] = [
  "general",
  "models",
  "appearance",
  "server",
  "updates",
  "mcp",
  "skills",
  "usage",
  "personalization",
  "privacy",
  "system",
  "archives",
  "about",
];

export function visibleSettingsSectionIds(
  developerModeEnabled = false,
): SettingsSectionId[] {
  if (!developerModeEnabled) return [...BASE_SETTINGS_SECTION_IDS];
  return [
    ...BASE_SETTINGS_SECTION_IDS.slice(0, 8),
    "logs",
    ...BASE_SETTINGS_SECTION_IDS.slice(8),
  ];
}
