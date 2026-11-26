import {
  AiChip,
  Blocks,
  Notebook,
  Archive,
  Activity,
  BookOpenText,
  Database,
  Lock,
  Globe2,
  IdCard,
  MagicWand,
  McpServer,
  Monitor,
  Palette,
  RefreshCcw,
  Server,
  SlidersHorizontal,
  Smartphone,
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
    account: section("account", settingsCopy.sections.account, <IdCard />),
    connections: section("connections", settingsCopy.sections.connections, <Blocks />),
    browser: section("browser", settingsCopy.sections.browser, <Globe2 />),
    devices: section("devices", settingsCopy.sections.devices, <Smartphone />),
    computers: section("computers", settingsCopy.sections.computers, <Monitor />),
    security: section("security", settingsCopy.sections.security, <Lock />),
    system: section("system", settingsCopy.sections.system, <Activity />),
    archives: section("archives", settingsCopy.sections.archive, <Archive />),
    about: section("about", settingsCopy.sections.about, <BookOpenText />),
  };
}

export function createSettingsSections(
  settingsCopy: SettingsCopy,
  developerModeEnabled = false,
  accountEnabled = false,
): SettingsSectionDescriptor[] {
  const sections = createSettingsSectionMap(settingsCopy);
  return visibleSettingsSectionIds(developerModeEnabled, accountEnabled).map((id) => sections[id]);
}

type SettingsSectionGroupDefinition = {
  id: SettingsSectionGroupId;
  label: keyof SettingsCopy["groups"];
  sectionIds: SettingsSectionDescriptor["id"][];
};

const SETTINGS_SECTION_GROUPS: SettingsSectionGroupDefinition[] = [
  {
    id: "personal",
    label: "personal",
    sectionIds: ["general", "account", "personalization", "appearance"],
  },
  {
    id: "butler",
    label: "butler",
    sectionIds: ["models", "memory", "archives", "usage"],
  },
  {
    id: "devices-security",
    label: "devicesAndSecurity",
    sectionIds: ["devices", "computers", "browser", "security"],
  },
  {
    id: "extensions",
    label: "extensions",
    sectionIds: ["mcp", "hooks", "skills", "connections"],
  },
  {
    id: "app",
    label: "app",
    sectionIds: ["server", "updates", "system", "logs", "about"],
  },
];

export function createSettingsSectionGroups(
  settingsCopy: SettingsCopy,
  developerModeEnabled = false,
  accountEnabled = false,
): SettingsSectionGroupDescriptor[] {
  const sections = createSettingsSectionMap(settingsCopy);
  const visibleIds = new Set(visibleSettingsSectionIds(developerModeEnabled, accountEnabled));

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
