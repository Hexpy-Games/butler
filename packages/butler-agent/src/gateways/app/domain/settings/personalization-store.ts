import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PERSONALIZATION_PROFILE_STORAGE_LABEL,
  readPersonalizationProfile,
  updatePersonalizationProfile,
} from "../../../../personalization/profile.ts";
import {
  clearProfilingData,
  importProfileCandidatesFromThirdPartyDumpWithModel,
  PROFILE_BLACK_BOX_STORAGE_LABEL,
  readProfilingExtractorModelConfig,
  readProfilingConsentSnapshot,
  setProfilingExtractorModel,
  setProfilingExtractorReasoningEffort,
  setProfilingMode,
} from "../../../../personalization/profiling.ts";
import { readPersonaPresets } from "../../../../personalization/persona-presets.ts";
import {
  readConfigUserSettings,
  writeConfigUserSettings,
} from "./settings-config.ts";
import {
  backupPrivatePersonalizationFile,
  boundedPrivateText,
  readPrivateText,
} from "./personalization-file-storage.ts";
import type {
  PersonalizationProfileMigrationRequest,
  PersonalizationProfileMigrationResultView,
  PersonalizationView,
  SettingsView,
  UpdatePersonalizationRequest,
} from "../../interface/protocol/app-protocol.ts";

export class AppPersonalizationStore {
  constructor(
    private readonly butlerData: string,
    private readonly butlerHome: string,
    private readonly getSettings: () => SettingsView,
    private readonly appendEvent: (
      type: string,
      payload: Record<string, unknown>,
    ) => void,
  ) {}

  get(): PersonalizationView {
    const profile = readPersonalizationProfile(this.butlerData);
    const profiling = readProfilingConsentSnapshot(this.butlerData);
    const extractorModel = readProfilingExtractorModelConfig(this.butlerData);
    const settings = this.getSettings();
    const configUserSettings = readConfigUserSettings(this.butlerData);
    return {
      persona: readPrivateText(join(this.butlerData, "personas", "active.md")),
      eol: readPrivateText(join(this.butlerData, "eol.md")),
      updated_at: new Date().toISOString(),
      response_language:
        configUserSettings.responseLanguage ??
        (settings.language === "ko" ? "ko" : "en"),
      persona_presets: readPersonaPresets(this.butlerHome, settings.language),
      profile: {
        ...profile,
        storage_label: PERSONALIZATION_PROFILE_STORAGE_LABEL,
      },
      profiling: {
        mode: profiling.mode,
        enabled: profiling.mode !== "off",
        consent_version: profiling.consent_version,
        consented_at: profiling.consented_at,
        storage_label: PROFILE_BLACK_BOX_STORAGE_LABEL,
        raw_profile_browser_visible: false,
        extractor_model: extractorModel.configured_model ?? "default",
        extractor_reasoning_effort: extractorModel.reasoning_effort,
        effective_extractor_model: extractorModel.effective_model,
        extractor_uses_butler_model: extractorModel.uses_butler_model,
      },
    };
  }

  update(input: UpdatePersonalizationRequest): PersonalizationView {
    if (typeof input.persona === "string") {
      const personaPath = join(this.butlerData, "personas", "active.md");
      mkdirSync(join(this.butlerData, "personas"), { recursive: true });
      const personaText = boundedPrivateText(input.persona);
      backupPrivatePersonalizationFile(
        this.butlerData,
        personaPath,
        "persona-active",
        personaText,
      );
      writeFileSync(personaPath, personaText, "utf8");
    }
    if (typeof input.eol === "string") {
      mkdirSync(this.butlerData, { recursive: true });
      const eolPath = join(this.butlerData, "eol.md");
      const eolText = boundedPrivateText(input.eol);
      backupPrivatePersonalizationFile(this.butlerData, eolPath, "eol", eolText);
      writeFileSync(eolPath, eolText, "utf8");
    }
    const updatedProfile = input.profile
      ? updatePersonalizationProfile(this.butlerData, input.profile)
      : null;
    const updatedProfiling = input.profiling?.mode
      ? setProfilingMode(this.butlerData, input.profiling.mode)
      : null;
    const updatedExtractorModel =
      typeof input.profiling?.extractor_model === "string"
        ? setProfilingExtractorModel(
            this.butlerData,
            input.profiling.extractor_model,
          )
        : null;
    const updatedExtractorReasoning =
      typeof input.profiling?.extractor_reasoning_effort === "string"
        ? setProfilingExtractorReasoningEffort(
            this.butlerData,
            input.profiling.extractor_reasoning_effort,
          )
        : null;
    if (input.response_language === "en" || input.response_language === "ko") {
      writeConfigUserSettings(this.butlerData, {
        responseLanguage: input.response_language,
      });
    }
    const clearedProfile = input.profiling?.clear_profile
      ? clearProfilingData(this.butlerData)
      : null;
    this.appendEvent("personalization.updated", {
      persona_chars:
        typeof input.persona === "string"
          ? boundedPrivateText(input.persona).length
          : undefined,
      eol_chars:
        typeof input.eol === "string"
          ? boundedPrivateText(input.eol).length
          : undefined,
      profile_fields: updatedProfile
        ? Object.keys(input.profile ?? {}).sort()
        : undefined,
      profiling_mode: updatedProfiling?.mode,
      profiling_extractor_model:
        updatedExtractorModel?.configured_model ?? undefined,
      profiling_extractor_reasoning_effort:
        updatedExtractorReasoning?.reasoning_effort,
      response_language: input.response_language,
      profile_black_box_cleared: clearedProfile
        ? {
            removed_candidates: clearedProfile.removed_candidates,
            removed_stable_entries: clearedProfile.removed_stable_entries,
            removed_runtime_projections:
              clearedProfile.removed_runtime_projections,
          }
        : undefined,
    });
    return this.get();
  }

  async importProfile(
    input: PersonalizationProfileMigrationRequest,
  ): Promise<PersonalizationProfileMigrationResultView> {
    const result = await importProfileCandidatesFromThirdPartyDumpWithModel(
      this.butlerData,
      {
        source: input.source,
        text: input.text,
        model: input.model,
      },
    );
    this.appendEvent("personalization.profile_imported", {
      source: result.source,
      import_id: result.import_id,
      profiling_enabled: result.profiling_enabled,
      model_called: result.model_called,
      imported_candidate_count: result.imported_candidate_count,
      promoted_count: result.promoted_count,
      stable_entry_count: result.stable_entry_count,
      raw_text_included: false,
    });
    return {
      profiling_enabled: result.profiling_enabled,
      mode: result.mode,
      source: result.source,
      import_id: result.import_id,
      imported_candidate_count: result.imported_candidate_count,
      promoted_count: result.promoted_count,
      skipped_count: result.skipped_count,
      stable_entry_count: result.stable_entry_count,
      projection_written: result.projection_written,
      raw_text_included: false,
      model_called: result.model_called,
      fallback_used: false,
      personalization: this.get(),
    };
  }
}
