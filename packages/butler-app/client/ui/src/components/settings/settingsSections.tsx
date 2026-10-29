import {
  AiChip,
  Notebook,
  Archive,
  Activity,
  BookOpenText,
  Database,
  Lock,
  Globe2,
  MagicWand,
  McpServer,
  Palette,
  RefreshCcw,
  Server,
  SlidersHorizontal,
  Terminal,
  UserRound,
} from "@/butler-ds";
import type {
  SettingsCopy,
  SettingsSectionDescriptor,
  SettingsSectionGroupDescriptor,
  SettingsSectionGroupId,
} from "./settingsTypes";
import { visibleSettingsSectionIds } from "./settingsSectionIds";
import { settingsSearchAliases } from "./settingsSearch";

function createSettingsSectionMap(
  settingsCopy: SettingsCopy,
): Record<SettingsSectionDescriptor["id"], SettingsSectionDescriptor> {
  const section = (
    id: SettingsSectionDescriptor["id"],
    label: string,
    icon: SettingsSectionDescriptor["icon"],
  ): SettingsSectionDescriptor => ({
    id,
    label,
    description: settingsCopy.sectionDescriptions[id],
    aliases: settingsSearchAliases(settingsCopy, id),
    icon,
  });

  return {
    memory: section("memory", settingsCopy.sections.memory, <Notebook />),
    general: section("general", settingsCopy.sections.general, <SlidersHorizontal />),
    models: section("models", settingsCopy.sections.models, <AiChip />),
    appearance: section("appearance", settingsCopy.sections.appearance, <Palette />),
    server: section("server", settingsCopy.sections.server, <Server />),
    updates: section("updates", settingsCopy.sections.updates, <RefreshCcw />),
    hooks: section("hooks", settingsCopy.sections.hooks, <Terminal />),
    mcp: section("mcp", settingsCopy.sections.mcp, <McpServer />),
    skills: section("skills", settingsCopy.sections.skills, <MagicWand />),
    usage: section("usage", settingsCopy.sections.usage, <Database />),
    logs: section("logs", settingsCopy.sections.logs, <Terminal />),
    personalization: section("personalization", settingsCopy.sections.personalization, <UserRound />),
    browser: section("browser", settingsCopy.sections.browser, <Globe2 />),
    security: section("security", settingsCopy.sections.security, <Lock />),
    system: section("system", settingsCopy.sections.system, <Activity />),
    archives: section("archives", settingsCopy.sections.archives, <Archive />),
    about: section("about", settingsCopy.sections.about, <BookOpenText />),
  };
}

export function createSettingsSections(
  settingsCopy: SettingsCopy,
  developerModeEnabled = false,
): SettingsSectionDescriptor[] {
  const sections = createSettingsSectionMap(settingsCopy);
  return visibleSettingsSectionIds(developerModeEnabled).map((id) => sections[id]);
}

type SettingsSectionGroupDefinition = {
  id: SettingsSectionGroupId;
  label: keyof SettingsCopy["groups"];
  sectionIds: SettingsSectionDescriptor["id"][];
};

const SETTINGS_SECTION_GROUPS: SettingsSectionGroupDefinition[] = [
  {
    id: "general",
    label: "preferences",
    sectionIds: ["general", "appearance", "personalization", "memory", "models"],
  },
  {
    id: "app-and-system",
    label: "appAndSystem",
    sectionIds: [
      "updates",
      "usage",
      "logs",
      "browser",
      "security",
      "system",
      "archives",
      "about",
    ],
  },
  // Agent-level settings most people never need; always the last group.
  {
    id: "advanced",
    label: "advanced",
    sectionIds: ["mcp", "hooks", "skills", "server"],
  },
];

export function createSettingsSectionGroups(
  settingsCopy: SettingsCopy,
  developerModeEnabled = false,
): SettingsSectionGroupDescriptor[] {
  const sections = createSettingsSectionMap(settingsCopy);
  const visibleIds = new Set(visibleSettingsSectionIds(developerModeEnabled));

  return SETTINGS_SECTION_GROUPS.map((group) => ({
    id: group.id,
    label: settingsCopy.groups[group.label],
    sections: group.sectionIds
      .filter((id) => visibleIds.has(id))
      .map((id) => sections[id]),
  }));
}

export { matchesSettingsSection, filterSettingsSectionGroups } from "./settingsSearch";

export { settingsPageSchema, type SettingsSectionSchema } from "./settingsPageSchema";
