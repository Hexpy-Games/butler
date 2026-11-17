import type { SettingsSectionId } from "../../app/types.ts";

// Everyday pages first; agent-level pages (the Advanced group) last.
const BASE_SETTINGS_SECTION_IDS: SettingsSectionId[] = [
  "general",
  "appearance",
  "personalization",
  "memory",
  "models",
  "connections",
  "updates",
  "usage",
  "browser",
  "security",
  "system",
  "archives",
  "about",
  "mcp",
  "hooks",
  "skills",
  "server",
];

export function visibleSettingsSectionIds(
  developerModeEnabled = false,
  accountEnabled = false,
): SettingsSectionId[] {
  const sectionIds = [...BASE_SETTINGS_SECTION_IDS];
  if (accountEnabled) sectionIds.splice(sectionIds.indexOf("personalization") + 1, 0, "account");
  if (!developerModeEnabled) return sectionIds;
  const afterUsage = sectionIds.indexOf("usage") + 1;
  return [
    ...sectionIds.slice(0, afterUsage),
    "logs",
    ...sectionIds.slice(afterUsage),
  ];
}
