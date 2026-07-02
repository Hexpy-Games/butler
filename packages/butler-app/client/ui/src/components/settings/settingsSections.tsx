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
import type { SettingsCopy, SettingsSectionDescriptor } from "./settingsTypes";
import { visibleSettingsSectionIds } from "./settingsSectionIds";

export function createSettingsSections(
  settingsCopy: SettingsCopy,
  developerModeEnabled = false,
): SettingsSectionDescriptor[] {
  const sections: Record<
    SettingsSectionDescriptor["id"],
    SettingsSectionDescriptor
  > = {
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
  return visibleSettingsSectionIds(developerModeEnabled).map((id) => sections[id]);
}
