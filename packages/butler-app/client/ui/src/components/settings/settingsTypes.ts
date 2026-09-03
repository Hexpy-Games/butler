import type { ReactNode } from "react";
import type { AppCopy } from "../../app/copy.ts";
import type {
  ProfilingMode,
  SettingsView as SettingsData,
  StatusTone,
} from "../../app/types.ts";
import type { SettingsSectionId } from "../../app/types.ts";

export type SettingsCopy = AppCopy["settings"];
export type SettingsUpdatePayload = Omit<Partial<SettingsData>, "web_search"> & {
  web_search?: Partial<SettingsData["web_search"]> & { api_key?: string };
  default_project_folder_selection_token?: string;
};
export type SettingsUpdate = (partial: SettingsUpdatePayload) => Promise<void>;
export type SettingsLocalMessage = { tone: StatusTone; label: string };
export type PersonalizationDraft = {
  persona: string;
  eol: string;
  responseLanguage: "en" | "ko";
  personaPreset: string;
  profile: {
    butler_nickname: string;
    principal_name: string;
    preferred_address: string;
  };
  profiling: {
    mode: ProfilingMode;
    extractorModel: string;
    extractorReasoningEffort: SettingsData["reasoning_effort"];
    clearProfile: boolean;
  };
};

export interface SettingsSectionDescriptor {
  id: SettingsSectionId;
  label: string;
  description: string;
  icon: ReactNode;
}

export type SettingsSectionGroupId =
  | "general"
  | "models-and-extensions"
  | "app-and-system";

export interface SettingsSectionGroupDescriptor {
  id: SettingsSectionGroupId;
  label: string;
  sections: SettingsSectionDescriptor[];
}
