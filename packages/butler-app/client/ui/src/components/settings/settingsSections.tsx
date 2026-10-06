import {
  AiChip,
  Notebook,
  Archive,
  Activity,
  BookOpenText,
  Database,
  Lock,
  MagicWand,
  McpServer,
  Palette,
  RefreshCcw,
  Server,
  ShieldCheck,
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
    aliases: settingsCopy.sectionAliases[id],
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
    privacy: section("privacy", settingsCopy.sections.privacy, <ShieldCheck />),
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
      "privacy",
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

function normalizeSettingsSearchValue(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function matchesSettingsSearchValue(value: string, query: string): boolean {
  return normalizeSettingsSearchValue(value).includes(query);
}

export function matchesSettingsSection(
  section: SettingsSectionDescriptor,
  query: string,
  fallback: string[] = [],
): boolean {
  const normalizedQuery = normalizeSettingsSearchValue(query);
  return [section.label, section.description, ...section.aliases, ...fallback]
    .some((value) => matchesSettingsSearchValue(value, normalizedQuery));
}

export function filterSettingsSectionGroups(
  groups: SettingsSectionGroupDescriptor[],
  query: string,
): SettingsSectionGroupDescriptor[] {
  const normalizedQuery = normalizeSettingsSearchValue(query);
  if (!normalizedQuery) return groups;

  return groups
    .map((group) => {
      if (matchesSettingsSearchValue(group.label, normalizedQuery)) return group;

      return {
        ...group,
        sections: group.sections.filter((section) =>
          matchesSettingsSection(section, normalizedQuery),
        ),
      };
    })
    .filter((group) => group.sections.length > 0);
}

export { settingsPageSchema, type SettingsSectionSchema } from "./settingsPageSchema";
