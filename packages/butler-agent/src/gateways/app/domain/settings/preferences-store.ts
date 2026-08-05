import {
  DEFAULT_MODEL_REF,
  DEFAULT_REASONING_EFFORT,
  resolveRegisteredRuntimeModelMetadata,
} from "../../../../integrations/providers/model-catalog.ts";
import {
  PROFILE_EXTRACTOR_MODEL_DEFAULT,
  readProfilingExtractorModelConfig,
  setProfilingExtractorModel,
  setProfilingExtractorReasoningEffort,
} from "../../../../personalization/profiling.ts";
import {
  readConfigDefaultModel,
  readConfigUserSettings,
  writeConfigUserSettings,
  type ConfigUserSettings,
} from "./settings-config.ts";
import {
  normalizeDesktopNotificationSettings,
  normalizedMainScreenThemeColorsOrDefault,
  normalizedMainScreenThemeOrDefault,
  normalizedMainScreenThemePresetOrDefault,
  normalizedMultilineSendBehaviorOrDefault,
  normalizeTimezone,
  sanitizeSettingsUpdate,
} from "./settings-preferences.ts";
import {
  clampContextWindowTokens,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_MODEL_FALLBACK_SETTINGS,
  normalizeModelFallbackSettings,
  normalizeWorkerModelRules,
} from "./settings-models.ts";
import {
  normalizeWebSearchSettings,
  readConfigWebSearchSettings,
  webSearchSettingsPatchFrom,
  writeConfigWebSearchSettings,
  writeWebSearchProviderApiKey,
} from "./web-search-settings.ts";
import { readProjectFolderSelectionToken } from "../projects/project-folder-selection-token.ts";
import { safeWorkspaceLabel } from "../sessions/session-read-model.ts";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTING_KEY,
  type AppSettingsPersistence,
} from "../settings/settings-persistence.ts";
import type { AppModelRegistryStore } from "../integrations/model-registry-store.ts";
import type { SettingsView, UpdateSettingsRequest } from "../../interface/protocol/app-protocol.ts";
import { repairGatewayProfileState } from "./gateway-profile-repair.ts";

export class AppPreferencesStore {
  constructor(
    private readonly butlerData: string,
    private readonly serverUrl: string,
    private readonly bridgeMode: SettingsView["bridge_mode"],
    private readonly folderSelectionSecret: string | undefined,
    private readonly persistence: AppSettingsPersistence,
    private readonly modelRegistry: AppModelRegistryStore,
    private readonly getProjectWorkspaceRoot: () => string,
    private readonly setProjectWorkspaceRoot: (workspaceRoot: string) => void,
    private readonly validateProjectFolder: (folderPath: string) => string,
    private readonly appendEvent: (
      type: string,
      payload: Record<string, unknown>,
    ) => void,
  ) {}

  getSettings(): SettingsView {
    const stored = repairGatewayProfileState({
      stored: this.persistence.read<Partial<SettingsView>>("settings") ?? {},
      persistence: this.persistence,
      appendEvent: this.appendEvent,
    });
    const registeredModels = this.modelRegistry.registeredModelMetadata();
    const consolidationModel = readProfilingExtractorModelConfig(
      this.butlerData,
    );
    const configUserSettings = readConfigUserSettings(this.butlerData);
    const configDefaultModel = readConfigDefaultModel(this.butlerData);
    const modelMetadata = resolveRegisteredRuntimeModelMetadata(
      stored.model ?? configDefaultModel ?? DEFAULT_MODEL_REF,
      registeredModels,
    );
    const storedReasoning = stored.reasoning_effort ?? DEFAULT_REASONING_EFFORT;
    const contextWindowTokens = clampContextWindowTokens(
      stored.context_window_tokens,
      modelMetadata.context_window_tokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
    );
    const modelFallback = normalizeModelFallbackSettings(
      configUserSettings.modelFallback ?? DEFAULT_MODEL_FALLBACK_SETTINGS,
      modelMetadata.model_ref,
      registeredModels,
    );
    const customColors = normalizedMainScreenThemeColorsOrDefault(
      stored.main_screen_theme_custom_colors,
    );
    return {
      bridge_mode: this.bridgeMode,
      gateway_profile: "electron",
      server_url: stored.server_url ?? this.serverUrl,
      default_project_workspace_label: safeWorkspaceLabel(
        this.getProjectWorkspaceRoot(),
      ),
      language:
        stored.language === "ko" || stored.language === "en"
          ? stored.language
          : (configUserSettings.language ?? "en"),
      timezone: normalizeTimezone(
        stored.timezone ?? configUserSettings.timezone,
      ),
      model: modelMetadata.model_ref,
      reasoning_effort: modelMetadata.reasoning_efforts.includes(
        storedReasoning,
      )
        ? storedReasoning
        : modelMetadata.default_reasoning_effort,
      consolidation_model:
        consolidationModel.configured_model ?? PROFILE_EXTRACTOR_MODEL_DEFAULT,
      consolidation_reasoning_effort: consolidationModel.reasoning_effort,
      effective_consolidation_model: consolidationModel.uses_butler_model
        ? modelMetadata.model_ref
        : consolidationModel.effective_model,
      consolidation_uses_butler_model: consolidationModel.uses_butler_model,
      context_window_tokens: contextWindowTokens,
      worker_model_rules: normalizeWorkerModelRules(
        stored.worker_model_rules,
        registeredModels,
        modelMetadata.model_ref,
      ),
      access_mode: stored.access_mode ?? "full_access",
      plan_mode_default: stored.plan_mode_default ?? false,
      follow_up_behavior: stored.follow_up_behavior ?? "queue",
      multiline_send_behavior: normalizedMultilineSendBehaviorOrDefault(
        stored.multiline_send_behavior,
      ),
      appearance_theme: stored.appearance_theme ?? "system",
      main_screen_theme: normalizedMainScreenThemeOrDefault(
        stored.main_screen_theme,
      ),
      main_screen_theme_preset: normalizedMainScreenThemePresetOrDefault(
        stored.main_screen_theme_preset,
        customColors,
      ),
      main_screen_theme_custom_colors: customColors,
      translucent_sidebar: stored.translucent_sidebar ?? true,
      diagnostics_enabled: stored.diagnostics_enabled ?? false,
      desktop_notifications: normalizeDesktopNotificationSettings(
        stored.desktop_notifications,
      ),
      desktop_tray_enabled: stored.desktop_tray_enabled ?? true,
      web_search: normalizeWebSearchSettings(
        {
          ...readConfigWebSearchSettings(this.butlerData),
          ...stored.web_search,
        },
        this.butlerData,
      ),
      model_fallback: modelFallback,
      profile_label: "Local Butler",
    };
  }

  updateSettings(input: UpdateSettingsRequest): SettingsView {
    const registeredModels = this.modelRegistry.registeredModelMetadata();
    const sanitized = sanitizeSettingsUpdate(input, registeredModels);
    const webSearchPatch = sanitized.web_search
      ? webSearchSettingsPatchFrom(sanitized.web_search)
      : undefined;
    const webSearchApiKey = sanitized.web_search?.api_key;
    if (typeof sanitized.consolidation_model === "string") {
      setProfilingExtractorModel(this.butlerData, sanitized.consolidation_model);
    }
    if (typeof sanitized.consolidation_reasoning_effort === "string") {
      setProfilingExtractorReasoningEffort(
        this.butlerData,
        sanitized.consolidation_reasoning_effort,
      );
    }
    const hasModelFallbackPatch = Object.prototype.hasOwnProperty.call(
      input,
      "model_fallback",
    );
    const modelFallbackPatch = sanitized.model_fallback;
    const {
      model_fallback: _ignoredModelFallback,
      ...sanitizedSettings
    } = sanitized;
    const current = this.getSettings();
    const hasPrimaryModelUpdate = typeof sanitized.model === "string";
    const shouldPersistModelFallback =
      hasModelFallbackPatch || hasPrimaryModelUpdate;
    if (webSearchApiKey) {
      writeWebSearchProviderApiKey(
        this.butlerData,
        webSearchPatch?.provider ?? current.web_search.provider,
        webSearchApiKey,
      );
    }
    let nextProjectWorkspaceRoot = this.getProjectWorkspaceRoot();
    if (
      typeof input.default_project_folder_selection_token === "string" &&
      input.default_project_folder_selection_token.trim()
    ) {
      const selectedPath = readProjectFolderSelectionToken(
        input.default_project_folder_selection_token,
        this.folderSelectionSecret,
      );
      nextProjectWorkspaceRoot = this.validateProjectFolder(selectedPath);
    }
    const candidate: SettingsView = {
      ...current,
      ...sanitizedSettings,
      model_fallback: current.model_fallback,
      desktop_notifications: sanitized.desktop_notifications
        ? normalizeDesktopNotificationSettings({
            ...current.desktop_notifications,
            ...sanitized.desktop_notifications,
          })
        : current.desktop_notifications,
      web_search: normalizeWebSearchSettings(
        {
          ...current.web_search,
          ...webSearchPatch,
        },
        this.butlerData,
      ),
      default_project_workspace_label: safeWorkspaceLabel(
        nextProjectWorkspaceRoot,
      ),
      profile_label: current.profile_label,
    };
    const modelMetadata = resolveRegisteredRuntimeModelMetadata(
      candidate.model,
      registeredModels,
    );
    const currentModelMetadata = resolveRegisteredRuntimeModelMetadata(
      current.model,
      registeredModels,
    );
    const contextWindowTokens =
      "context_window_tokens" in input
        ? candidate.context_window_tokens
        : current.context_window_tokens >=
            (currentModelMetadata.context_window_tokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS)
          ? (modelMetadata.context_window_tokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS)
          : candidate.context_window_tokens;
    const next: SettingsView = {
      ...candidate,
      model: modelMetadata.model_ref,
      reasoning_effort: modelMetadata.reasoning_efforts.includes(
        candidate.reasoning_effort,
      )
        ? candidate.reasoning_effort
        : modelMetadata.default_reasoning_effort,
      effective_consolidation_model: candidate.consolidation_uses_butler_model
        ? modelMetadata.model_ref
        : candidate.effective_consolidation_model,
      context_window_tokens: clampContextWindowTokens(
        contextWindowTokens,
        modelMetadata.context_window_tokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
      ),
      model_fallback: shouldPersistModelFallback
        ? normalizeModelFallbackSettings(
            {
              enabled:
                modelFallbackPatch?.enabled ?? current.model_fallback.enabled,
              models:
                modelFallbackPatch?.models ?? current.model_fallback.models,
            },
            modelMetadata.model_ref,
            registeredModels,
          )
        : current.model_fallback,
    };
    if (sanitized.web_search) {
      writeConfigWebSearchSettings(this.butlerData, next.web_search);
    }
    const configUserPatch: ConfigUserSettings = {};
    if (sanitized.timezone) configUserPatch.timezone = next.timezone;
    if (sanitized.language) {
      configUserPatch.language = next.language;
      if (!readConfigUserSettings(this.butlerData).responseLanguage) {
        configUserPatch.responseLanguage = next.language;
      }
    }
    if (shouldPersistModelFallback) {
      configUserPatch.modelFallback = next.model_fallback;
    }
    if (Object.keys(configUserPatch).length > 0) {
      writeConfigUserSettings(this.butlerData, configUserPatch);
    }
    const {
      model_fallback: _modelFallbackProjection,
      ...settingsProjection
    } = next;
    this.persistence.write("settings", settingsProjection);
    this.appendEvent("settings.updated", {
      settings: {
        bridge_mode: next.bridge_mode,
        language: next.language,
        model: next.model,
        reasoning_effort: next.reasoning_effort,
        timezone: next.timezone,
        consolidation_model: next.consolidation_model,
        consolidation_reasoning_effort: next.consolidation_reasoning_effort,
        effective_consolidation_model: next.effective_consolidation_model,
        context_window_tokens: next.context_window_tokens,
        worker_model_rule_count: next.worker_model_rules.filter(
          (rule) => rule.enabled,
        ).length,
        access_mode: next.access_mode,
        appearance_theme: next.appearance_theme,
        main_screen_theme: next.main_screen_theme,
        main_screen_theme_preset: next.main_screen_theme_preset,
        translucent_sidebar: next.translucent_sidebar,
        desktop_notifications: next.desktop_notifications,
        desktop_tray_enabled: next.desktop_tray_enabled,
        web_search: next.web_search,
        model_fallback: next.model_fallback,
        default_project_workspace_label: next.default_project_workspace_label,
      },
    });
    if (nextProjectWorkspaceRoot !== this.getProjectWorkspaceRoot()) {
      this.setProjectWorkspaceRoot(nextProjectWorkspaceRoot);
      this.persistence.write(
        DEFAULT_PROJECT_WORKSPACE_SETTING_KEY,
        nextProjectWorkspaceRoot,
      );
    }
    return next;
  }
}
