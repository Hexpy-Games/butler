import type { SettingsView } from "./settings-contract.ts";

export interface PersonalizationView {
  persona: string;
  eol: string;
  updated_at: string;
  response_language: "en" | "ko";
  persona_presets: PersonaPresetView[];
  profile: PersonalizationProfileView;
  profiling: PersonalizationProfilingView;
}

export interface PersonaPresetView {
  name: string;
  label: string;
  description: string;
  preview: string;
  locale: "en" | "ko";
  content: string;
}

export interface PersonalizationProfileView {
  butler_nickname: string;
  principal_name: string;
  preferred_address: string;
  updated_at: string | null;
  storage_label: string;
}

export interface PersonalizationProfileUpdateRequest {
  butler_nickname?: string;
  principal_name?: string;
  preferred_address?: string;
}

export interface PersonalizationProfilingView {
  mode: "off" | "basic" | "deep";
  enabled: boolean;
  consent_version: string;
  consented_at: string | null;
  storage_label: string;
  raw_profile_browser_visible: false;
  extractor_model: string;
  extractor_reasoning_effort: SettingsView["reasoning_effort"];
  effective_extractor_model: string;
  extractor_uses_butler_model: boolean;
}

export interface PersonalizationProfilingUpdateRequest {
  mode?: "off" | "basic" | "deep";
  extractor_model?: string;
  extractor_reasoning_effort?: SettingsView["reasoning_effort"];
  clear_profile?: boolean;
}

export interface PersonalizationProfileMigrationRequest {
  source?: string;
  text: string;
  model?: string;
}

export interface PersonalizationProfileMigrationPromptView {
  locale: "en" | "ko";
  prompt: string;
  raw_profile_included: false;
}

export interface PersonalizationProfileMigrationResultView {
  profiling_enabled: boolean;
  mode: "off" | "basic" | "deep";
  source: string;
  import_id: string | null;
  imported_candidate_count: number;
  promoted_count: number;
  skipped_count: number;
  stable_entry_count: number;
  projection_written: boolean;
  raw_text_included: false;
  model_called: boolean;
  fallback_used: false;
  personalization: PersonalizationView;
}

export interface UpdatePersonalizationRequest {
  persona?: string;
  eol?: string;
  response_language?: PersonalizationView["response_language"];
  profile?: PersonalizationProfileUpdateRequest;
  profiling?: PersonalizationProfilingUpdateRequest;
}
