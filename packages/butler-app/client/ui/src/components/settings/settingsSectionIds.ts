import type { SettingsSectionId } from "../../app/types.ts";

// Everyday pages first; agent-level pages (the Advanced group) last.
const BASE_SETTINGS_SECTION_IDS: SettingsSectionId[] = [
  "general",
  "appearance",
  "personalization",
  "models",
  "updates",
  "usage",
  "privacy",
  "system",
  "archives",
  "about",
  "helpers",
  "mcp",
  "skills",
  "server",
];

export function visibleSettingsSectionIds(
  developerModeEnabled = false,
): SettingsSectionId[] {
  if (!developerModeEnabled) return [...BASE_SETTINGS_SECTION_IDS];
  const afterUsage = BASE_SETTINGS_SECTION_IDS.indexOf("usage") + 1;
  return [
    ...BASE_SETTINGS_SECTION_IDS.slice(0, afterUsage),
    "logs",
    ...BASE_SETTINGS_SECTION_IDS.slice(afterUsage),
  ];
}
