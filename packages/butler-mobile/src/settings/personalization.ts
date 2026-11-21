import type { PersonalizationView, PersonaPresetView, ProfilingMode, SettingsView, UpdatePersonalizationRequest } from "./types";
type PersonalizationProfileView = PersonalizationView["profile"];
export type PersonalizationDraft = {
  persona: string;
  eol: string;
  responseLanguage: "en" | "ko";
  personaPreset: string;
  profile: { butler_nickname: string; principal_name: string; preferred_address: string };
  profiling: { mode: ProfilingMode; extractorModel: string; extractorReasoningEffort: SettingsView["reasoning_effort"] };
};

export function draftFromPersonalization(
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
        .extractorReasoningEffort
  );
}

export function personalizationUpdatePayload(
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
        .extractorReasoningEffort
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
  };
}

function emptyProfilingDraft(): PersonalizationDraft["profiling"] {
  return {
    mode: "off",
    extractorModel: "default",
    extractorReasoningEffort: "medium",
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

export function resolvePersonaPreset(
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


function personaFrontmatter(text: string): string | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  return match?.[1] ?? null;
}

export function selectPersonaPreset(draft: PersonalizationDraft, personalization: PersonalizationView, presetName: string): PersonalizationDraft {
  if (presetName === "custom") return { ...draft, personaPreset: "custom" };
  const preset = personaPresetsFrom(personalization).find(candidate => candidate.name === presetName);
  return preset ? { ...draft, persona: editablePersonaText(preset.content), personaPreset: preset.name } : draft;
}
