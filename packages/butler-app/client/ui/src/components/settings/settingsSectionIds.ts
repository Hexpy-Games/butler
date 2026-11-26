import type { SettingsSectionId } from "../../app/types.ts";

// Follows the settings navigation order.
const BASE_SETTINGS_SECTION_IDS: SettingsSectionId[] = [
  "general",
  "personalization",
  "appearance",
  "models",
  "memory",
  "archives",
  "usage",
  "devices",
  "computers",
  "browser",
  "security",
  "mcp",
  "hooks",
  "skills",
  "connections",
  "server",
  "updates",
  "system",
  "about",
];

export function visibleSettingsSectionIds(
  developerModeEnabled = false,
  accountEnabled = false,
): SettingsSectionId[] {
  const sectionIds = [...BASE_SETTINGS_SECTION_IDS];
  if (accountEnabled) sectionIds.splice(sectionIds.indexOf("general") + 1, 0, "account");
  if (!developerModeEnabled) return sectionIds;
  const afterSystem = sectionIds.indexOf("system") + 1;
  return [
    ...sectionIds.slice(0, afterSystem),
    "logs",
    ...sectionIds.slice(afterSystem),
  ];
}
