import { create } from "zustand";
import { api, selectProjectFolder } from "../app/api.ts";
import {
  DEFAULT_WEB_SEARCH_SETTINGS,
  EMPTY_SETTINGS,
} from "../app/constants.ts";
import { appCopy } from "../app/copy.ts";
import {
  notifyError,
  notifyLoading,
  notifyStatus,
} from "../app/notifications.ts";
import { profileMigrationFeedbackFromResult } from "../app/profileMigrationFeedback.ts";
import type {
  PersonalizationProfileMigrationResultView,
  PersonalizationProfileView,
  PersonalizationView,
  PersonaPresetView,
  SettingsSectionId,
  SettingsView as SettingsData,
  UpdatePersonalizationRequest,
} from "../app/types.ts";
import type {
  PersonalizationDraft,
  SettingsLocalMessage,
  SettingsUpdatePayload,
} from "../components/settings/settingsTypes.ts";

export type SettingsModelRoute =
  | { page: "root" }
  | { page: "management" }
  | { page: "add" }
  | { page: "edit"; modelRef: string };

interface SettingsUIStore {
  // Settings draft state (UI-only, not persisted in useButlerStore)
  draft: SettingsData | null;
  setDraft: (draft: SettingsData) => void;

  // Personalization state (separate from settings)
  personalization: PersonalizationView | null;
  personalizationDraft: PersonalizationDraft;
  setPersonalizationDraft: (
    draft:
      | PersonalizationDraft
      | ((current: PersonalizationDraft) => PersonalizationDraft),
  ) => void;
  selectPersonaPreset: (presetName: string) => void;

  // UI state
  activeSection: SettingsSectionId;
  setActiveSection: (section: SettingsSectionId) => boolean;
  modelRoute: SettingsModelRoute;
  modelRouteDirection: "forward" | "back";
  modelRouteLeaveGuard: (() => boolean) | null;
  openModelManagement: () => void;
  openModelAdd: () => void;
  openModelEdit: (modelRef: string) => void;
  backModelRoute: () => void;
  resetModelRoute: () => void;
  setModelRouteLeaveGuard: (guard: (() => boolean) | null) => void;
  saving: boolean;
  localMessage: SettingsLocalMessage | null;
  setLocalMessage: (message: SettingsLocalMessage | null) => void;

  // Actions
  initialize: (
    settings: SettingsData,
    initialSection?: SettingsSectionId | string,
  ) => Promise<void>;
  update: (
    partial: SettingsUpdatePayload,
    onSettingsChange: (settings: SettingsData) => void,
  ) => Promise<void>;
  savePersonalization: () => Promise<void>;
  importProfileMigration: (
    text: string,
  ) => Promise<PersonalizationProfileMigrationResultView | null>;
  chooseDefaultProjectFolder: (
    onSettingsChange: (settings: SettingsData) => void,
  ) => Promise<void>;
}

export const useSettingsUIStore = create<SettingsUIStore>((set, get) => ({
  // Initial state
  draft: null,
  personalization: null,
  personalizationDraft: {
    persona: "",
    eol: "",
    responseLanguage: "en",
    personaPreset: "custom",
    profile: emptyProfileDraft(),
    profiling: emptyProfilingDraft(),
  },
  activeSection: "general",
  modelRoute: { page: "root" },
  modelRouteDirection: "forward",
  modelRouteLeaveGuard: null,
  saving: false,
  localMessage: null,

  // Setters
  setDraft: (draft) => set({ draft }),
  setPersonalizationDraft: (draft) =>
    set((state) => ({
      personalizationDraft:
        typeof draft === "function" ? draft(state.personalizationDraft) : draft,
    })),
  selectPersonaPreset: (presetName) =>
    set((state) => {
      if (presetName === "custom") {
        return {
          personalizationDraft: {
            ...state.personalizationDraft,
            personaPreset: "custom",
          },
        };
      }
      const preset = personaPresetsFrom(state.personalization).find(
        (candidate) => candidate.name === presetName,
      );
      if (!preset) return state;
      return {
        personalizationDraft: {
          ...state.personalizationDraft,
          persona: editablePersonaText(preset.content),
          personaPreset: preset.name,
        },
      };
    }),
  setActiveSection: (activeSection) => {
    const state = get();
    if (
      activeSection !== "models" &&
      state.modelRoute.page !== "root" &&
      !canLeaveModelRoute(state.modelRouteLeaveGuard)
    ) {
      return false;
    }
    set({
      activeSection,
      ...(activeSection === "models"
        ? {}
        : {
            modelRoute: { page: "root" } as SettingsModelRoute,
            modelRouteDirection: "back" as const,
          }),
    });
    return true;
  },
  openModelManagement: () =>
    set({
      modelRoute: { page: "management" },
      modelRouteDirection: "forward",
    }),
  openModelAdd: () =>
    set({
      modelRoute: { page: "add" },
      modelRouteDirection: "forward",
    }),
  openModelEdit: (modelRef) =>
    set({
      modelRoute: { page: "edit", modelRef },
      modelRouteDirection: "forward",
    }),
  backModelRoute: () =>
    set((state) => {
      if (!canLeaveModelRoute(state.modelRouteLeaveGuard)) return state;
      return {
        modelRoute:
          state.modelRoute.page === "add" || state.modelRoute.page === "edit"
            ? { page: "management" }
            : { page: "root" },
        modelRouteDirection: "back",
      };
    }),
  resetModelRoute: () =>
    set((state) => {
      if (!canLeaveModelRoute(state.modelRouteLeaveGuard)) return state;
      return {
        modelRoute: { page: "root" },
        modelRouteDirection: "back",
        modelRouteLeaveGuard: null,
      };
    }),
  setModelRouteLeaveGuard: (modelRouteLeaveGuard) =>
    set({ modelRouteLeaveGuard }),
  setLocalMessage: (localMessage) => set({ localMessage }),

  // Initialize - loads settings and personalization
  initialize: async (settings, initialSection = "general") => {
    set({
      draft: settingsDraftFrom(settings),
      activeSection: initialSection as SettingsSectionId,
      ...(initialSection === "models"
        ? {}
        : {
            modelRoute: { page: "root" } as SettingsModelRoute,
            modelRouteDirection: "back" as const,
            modelRouteLeaveGuard: null,
          }),
    });

    // Load personalization
    try {
      const personalization =
        await api<PersonalizationView>("/personalization");
      set({
        personalization,
        personalizationDraft: draftFromPersonalization(personalization),
      });
    } catch (error) {
      notifyError(error, appCopy.settings.errors.loadPersonalization, {
        id: "settings-personalization",
      });
    }
  },

  // Update settings
  update: async (partial, onSettingsChange) => {
    const { draft } = get();
    if (!draft) return;

    set({ saving: true, localMessage: null });
    try {
      const result = await api<SettingsData>("/settings", {
        method: "PATCH",
        body: JSON.stringify(partial),
      });
      const nextSettings = settingsDraftFrom({ ...draft, ...result });
      set({ draft: nextSettings });
      onSettingsChange(nextSettings);
      notifyStatus(appCopy.settings.saved, {
        id: "settings-update",
        tone: "ok",
      });
    } catch (error) {
      notifyError(error, appCopy.settings.errors.updateSettings, {
        id: "settings-update",
      });
    } finally {
      set({ saving: false });
    }
  },

  // Save personalization
  savePersonalization: async () => {
    const { personalization, personalizationDraft } = get();
    const payload = personalizationUpdatePayload(
      personalization,
      personalizationDraft,
    );
    set({ saving: true, localMessage: null });
    try {
      const saved = await api<PersonalizationView>("/personalization", {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      set({
        personalization: saved,
        personalizationDraft: draftFromPersonalization(saved),
      });
      notifyStatus(appCopy.settings.saved, {
        id: "personalization-update",
        tone: "ok",
      });
    } catch (error) {
      notifyError(error, appCopy.settings.errors.updatePersonalization, {
        id: "personalization-update",
      });
    } finally {
      set({ saving: false });
    }
  },

  importProfileMigration: async (text) => {
    set({ saving: true, localMessage: null });
    notifyLoading(appCopy.settings.descriptions.profileMigrationImporting, {
      id: "profile-migration",
    });
    try {
      const result = await api<PersonalizationProfileMigrationResultView>(
        "/personalization/profile-import",
        {
          method: "POST",
          body: JSON.stringify({ text }),
        },
      );
      const feedback = profileMigrationFeedbackFromResult(
        appCopy.settings,
        result,
      );
      set({
        personalization: result.personalization,
        personalizationDraft: draftFromPersonalization(result.personalization),
        localMessage: feedback,
      });
      notifyStatus(feedback.label, {
        id: "profile-migration",
        tone: feedback.tone,
      });
      return result;
    } catch (error) {
      notifyError(error, appCopy.settings.errors.profileMigration, {
        id: "profile-migration",
      });
      return null;
    } finally {
      set({ saving: false });
    }
  },

  // Choose default project folder
  chooseDefaultProjectFolder: async (onSettingsChange) => {
    try {
      const result = await selectProjectFolder();
      if (!result.folder_selection_token) return;
      await get().update(
        {
          default_project_folder_selection_token: result.folder_selection_token,
        },
        onSettingsChange,
      );
    } catch (error) {
      notifyError(error, appCopy.settings.errors.chooseFolder, {
        id: "settings-folder",
      });
    }
  },
}));

function draftFromPersonalization(
  personalization: PersonalizationView,
): PersonalizationDraft {
  const persona = personalization.persona ?? "";
  return {
    persona: editablePersonaText(persona),
    eol: personalization.eol ?? "",
    responseLanguage: personalization.response_language === "ko" ? "ko" : "en",
    personaPreset: resolvePersonaPreset(persona, personalization),
    profile: profileDraftFromPersonalization(personalization),
    profiling: profilingDraftFromPersonalization(personalization),
  };
}

export function personalizationDraftHasChanges(
  personalization: PersonalizationView | null,
  draft: PersonalizationDraft,
): boolean {
  if (!personalization) return false;
  const draftProfiling = draft.profiling ?? emptyProfilingDraft();
  return (
    personaDraftChanged(personalization, draft) ||
    draft.eol !== (personalization.eol ?? "") ||
    draft.responseLanguage !==
      (personalization.response_language === "ko" ? "ko" : "en") ||
    !profileDraftsEqual(
      draft.profile,
      profileDraftFromPersonalization(personalization),
    ) ||
    draftProfiling.mode !==
      profilingDraftFromPersonalization(personalization).mode ||
    draftProfiling.extractorModel !==
      profilingDraftFromPersonalization(personalization).extractorModel ||
    draftProfiling.extractorReasoningEffort !==
      profilingDraftFromPersonalization(personalization)
        .extractorReasoningEffort ||
    draftProfiling.clearProfile
  );
}

function personalizationUpdatePayload(
  personalization: PersonalizationView | null,
  draft: PersonalizationDraft,
): UpdatePersonalizationRequest {
  const payload: UpdatePersonalizationRequest = {};
  const draftProfiling = draft.profiling ?? emptyProfilingDraft();
  if (!personalization || personaDraftChanged(personalization, draft)) {
    payload.persona = personaPayloadFromDraft(draft, personalization);
  }
  if (!personalization || draft.eol !== (personalization.eol ?? "")) {
    payload.eol = draft.eol;
  }
  if (
    !personalization ||
    draft.responseLanguage !==
      (personalization.response_language === "ko" ? "ko" : "en")
  ) {
    payload.response_language = draft.responseLanguage;
  }
  if (
    !personalization ||
    !profileDraftsEqual(
      draft.profile,
      profileDraftFromPersonalization(personalization),
    )
  ) {
    payload.profile = draft.profile;
  }
  if (
    !personalization ||
    draftProfiling.mode !==
      profilingDraftFromPersonalization(personalization).mode ||
    draftProfiling.extractorModel !==
      profilingDraftFromPersonalization(personalization).extractorModel ||
    draftProfiling.extractorReasoningEffort !==
      profilingDraftFromPersonalization(personalization)
        .extractorReasoningEffort ||
    draftProfiling.clearProfile
  ) {
    const baseline = profilingDraftFromPersonalization(personalization);
    payload.profiling = {};
    if (!personalization || draftProfiling.mode !== baseline.mode) {
      payload.profiling.mode = draftProfiling.mode;
    }
    if (
      !personalization ||
      draftProfiling.extractorModel !== baseline.extractorModel
    ) {
      payload.profiling.extractor_model = draftProfiling.extractorModel;
    }
    if (
      !personalization ||
      draftProfiling.extractorReasoningEffort !==
        baseline.extractorReasoningEffort
    ) {
      payload.profiling.extractor_reasoning_effort =
        draftProfiling.extractorReasoningEffort;
    }
    if (draftProfiling.clearProfile) payload.profiling.clear_profile = true;
  }
  return payload;
}

function personaDraftChanged(
  personalization: PersonalizationView,
  draft: PersonalizationDraft,
): boolean {
  return (
    draft.persona !== editablePersonaText(personalization.persona ?? "") ||
    draft.personaPreset !==
      resolvePersonaPreset(personalization.persona ?? "", personalization)
  );
}

function personaPayloadFromDraft(
  draft: PersonalizationDraft,
  personalization: PersonalizationView | null,
): string {
  const preset = personaPresetsFrom(personalization).find(
    (candidate) => candidate.name === draft.personaPreset,
  );
  if (
    preset &&
    editablePersonaText(preset.content).trim() === draft.persona.trim()
  ) {
    return preset.content;
  }
  return draft.persona;
}

function profileDraftsEqual(
  left: PersonalizationDraft["profile"],
  right: PersonalizationDraft["profile"],
): boolean {
  return (
    left.butler_nickname === right.butler_nickname &&
    left.principal_name === right.principal_name &&
    left.preferred_address === right.preferred_address
  );
}

function profileDraftFromPersonalization(
  personalization: PersonalizationView | null,
): PersonalizationDraft["profile"] {
  const profile = personalization?.profile;
  if (!isPersonalizationProfile(profile)) return emptyProfileDraft();
  return {
    butler_nickname: profile.butler_nickname,
    principal_name: profile.principal_name,
    preferred_address: profile.preferred_address,
  };
}

function emptyProfileDraft(): PersonalizationDraft["profile"] {
  return {
    butler_nickname: "",
    principal_name: "",
    preferred_address: "",
  };
}

function settingsDraftFrom(settings: SettingsData): SettingsData {
  return {
    ...settings,
    timezone:
      typeof settings.timezone === "string" && settings.timezone.trim()
        ? settings.timezone
        : "UTC",
    consolidation_reasoning_effort:
      settings.consolidation_reasoning_effort ?? settings.reasoning_effort,
    main_screen_theme:
      settings.main_screen_theme ?? EMPTY_SETTINGS.main_screen_theme,
    main_screen_theme_preset:
      settings.main_screen_theme_preset ??
      EMPTY_SETTINGS.main_screen_theme_preset,
    main_screen_theme_custom_colors:
      settings.main_screen_theme_custom_colors ??
      EMPTY_SETTINGS.main_screen_theme_custom_colors,
    web_search: {
      ...DEFAULT_WEB_SEARCH_SETTINGS,
      ...(settings.web_search ?? {}),
    },
  };
}

function profilingDraftFromPersonalization(
  personalization: PersonalizationView | null,
): PersonalizationDraft["profiling"] {
  const mode = personalization?.profiling?.mode;
  const extractorModel = personalization?.profiling?.extractor_model;
  const extractorReasoningEffort =
    personalization?.profiling?.extractor_reasoning_effort;
  return {
    mode: mode === "basic" || mode === "deep" ? mode : "off",
    extractorModel:
      typeof extractorModel === "string" && extractorModel.trim()
        ? extractorModel
        : "default",
    extractorReasoningEffort:
      extractorReasoningEffort === "none" ||
      extractorReasoningEffort === "low" ||
      extractorReasoningEffort === "medium" ||
      extractorReasoningEffort === "high" ||
      extractorReasoningEffort === "xhigh" ||
      extractorReasoningEffort === "max"
        ? extractorReasoningEffort
        : "medium",
    clearProfile: false,
  };
}

function emptyProfilingDraft(): PersonalizationDraft["profiling"] {
  return {
    mode: "off",
    extractorModel: "default",
    extractorReasoningEffort: "medium",
    clearProfile: false,
  };
}

function isPersonalizationProfile(
  value: unknown,
): value is PersonalizationProfileView {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as Partial<PersonalizationProfileView>;
  return (
    typeof profile.butler_nickname === "string" &&
    typeof profile.principal_name === "string" &&
    typeof profile.preferred_address === "string"
  );
}

function resolvePersonaPreset(
  persona: string,
  personalization: PersonalizationView,
): string {
  const presets = personaPresetsFrom(personalization);
  const base =
    readFrontmatterField(persona, "base") ??
    readFrontmatterField(persona, "name");
  if (
    base &&
    base !== "active" &&
    presets.some((preset) => preset.name === base)
  ) {
    return base;
  }
  const exact = presets.find(
    (preset) =>
      preset.content.trim() === persona.trim() ||
      editablePersonaText(preset.content).trim() ===
        editablePersonaText(persona).trim(),
  );
  return exact?.name ?? "custom";
}

function personaPresetsFrom(
  personalization: PersonalizationView | null,
): PersonaPresetView[] {
  return Array.isArray(personalization?.persona_presets)
    ? personalization.persona_presets
    : [];
}

function readFrontmatterField(text: string, field: string): string | null {
  const frontmatter = personaFrontmatter(text);
  if (!frontmatter) return null;
  const match = frontmatter.match(new RegExp(`^${field}:\\s*([^\\n]+)`, "mu"));
  return match?.[1]?.trim().replace(/^"|"$/gu, "") ?? null;
}

export function editablePersonaText(text: string): string {
  const frontmatter = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n){0,2}/u);
  return frontmatter ? text.slice(frontmatter[0].length) : text;
}

function canLeaveModelRoute(guard: (() => boolean) | null): boolean {
  return guard ? guard() : true;
}

function personaFrontmatter(text: string): string | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  return match?.[1] ?? null;
}
