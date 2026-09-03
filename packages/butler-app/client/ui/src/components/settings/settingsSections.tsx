import {
  Archive,
  Activity,
  Blocks,
  BookOpenText,
  Database,
  Palette,
  RefreshCcw,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
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
  return {
    general: {
      id: "general",
      label: settingsCopy.sections.general,
      icon: <SlidersHorizontal />,
    },
    models: {
      id: "models",
      label: settingsCopy.sections.models,
      icon: <Sparkles />,
    },
    appearance: {
      id: "appearance",
      label: settingsCopy.sections.appearance,
      icon: <Palette />,
    },
    server: {
      id: "server",
      label: settingsCopy.sections.server,
      icon: <Server />,
    },
    updates: {
      id: "updates",
      label: settingsCopy.sections.updates,
      icon: <RefreshCcw />,
    },
    mcp: {
      id: "mcp",
      label: settingsCopy.sections.mcp,
      icon: <Blocks />,
    },
    skills: {
      id: "skills",
      label: settingsCopy.sections.skills,
      icon: <Sparkles />,
    },
    usage: {
      id: "usage",
      label: settingsCopy.sections.usage,
      icon: <Database />,
    },
    logs: {
      id: "logs",
      label: settingsCopy.sections.logs,
      icon: <Terminal />,
    },
    personalization: {
      id: "personalization",
      label: settingsCopy.sections.personalization,
      icon: <UserRound />,
    },
    privacy: {
      id: "privacy",
      label: settingsCopy.sections.privacy,
      icon: <ShieldCheck />,
    },
    system: {
      id: "system",
      label: settingsCopy.sections.system,
      icon: <Activity />,
    },
    archives: {
      id: "archives",
      label: settingsCopy.sections.archives,
      icon: <Archive />,
    },
    about: {
      id: "about",
      label: settingsCopy.sections.about,
      icon: <BookOpenText />,
    },
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
    label: "general",
    sectionIds: ["general", "appearance", "personalization"],
  },
  {
    id: "models-and-extensions",
    label: "modelsAndExtensions",
    sectionIds: ["models", "mcp", "skills"],
  },
  {
    id: "app-and-system",
    label: "appAndSystem",
    sectionIds: [
      "server",
      "updates",
      "usage",
      "logs",
      "privacy",
      "system",
      "archives",
      "about",
    ],
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
