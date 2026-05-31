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
  UserRound,
} from "@/butler-ds";
import type { SettingsCopy, SettingsSectionDescriptor } from "./settingsTypes";

export function createSettingsSections(
  settingsCopy: SettingsCopy,
): SettingsSectionDescriptor[] {
  return [
    {
      id: "general",
      label: settingsCopy.sections.general,
      icon: <SlidersHorizontal />,
    },
    {
      id: "models",
      label: settingsCopy.sections.models,
      icon: <Sparkles />,
    },
    {
      id: "appearance",
      label: settingsCopy.sections.appearance,
      icon: <Palette />,
    },
    {
      id: "server",
      label: settingsCopy.sections.server,
      icon: <Server />,
    },
    {
      id: "updates",
      label: settingsCopy.sections.updates,
      icon: <RefreshCcw />,
    },
    {
      id: "mcp",
      label: settingsCopy.sections.mcp,
      icon: <Blocks />,
    },
    {
      id: "skills",
      label: settingsCopy.sections.skills,
      icon: <Sparkles />,
    },
    {
      id: "usage",
      label: settingsCopy.sections.usage,
      icon: <Database />,
    },
    {
      id: "personalization",
      label: settingsCopy.sections.personalization,
      icon: <UserRound />,
    },
    {
      id: "privacy",
      label: settingsCopy.sections.privacy,
      icon: <ShieldCheck />,
    },
    {
      id: "system",
      label: settingsCopy.sections.system,
      icon: <Activity />,
    },
    {
      id: "archives",
      label: settingsCopy.sections.archives,
      icon: <Archive />,
    },
    {
      id: "about",
      label: settingsCopy.sections.about,
      icon: <BookOpenText />,
    },
  ];
}
