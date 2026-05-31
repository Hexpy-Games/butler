import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  readPersonalizationProfile,
  updatePersonalizationProfile,
  type PersonalizationProfile,
  type PersonalizationProfileUpdate,
} from "./profile.ts";
import {
  captureProfileCandidatesFromTextObservation,
  consolidateProfileCandidates,
  normalizeProfilingMode,
  readProfilingConsentSnapshot,
  setProfilingMode,
  type ProfilingMode,
} from "./profiling.ts";
import {
  readPersonaPreset,
  readPersonaPresets,
  safePersonaPresetName,
  type PersonaPresetLocale,
} from "./persona-presets.ts";

export const FIRST_CHAT_ONBOARDING_STORAGE_LABEL = "personalization/onboarding.json";

export type FirstChatOnboardingStatus = "pending" | "complete";
export type FirstChatOnboardingPersonaPreset = string;

export interface FirstChatOnboardingFields {
  interests?: string;
  work?: string;
  service_preference?: string;
  persona_preset?: FirstChatOnboardingPersonaPreset | "custom";
  persona_custom?: string;
  profiling_mode?: ProfilingMode;
}

export interface FirstChatOnboardingState {
  schema: "butler.first_chat_onboarding.v1";
  status: FirstChatOnboardingStatus;
  gateway: "any";
  fields: FirstChatOnboardingFields;
  skipped_fields: string[];
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface FirstChatOnboardingUpdate {
  principal_name?: string;
  preferred_address?: string;
  butler_nickname?: string;
  interests?: string;
  work?: string;
  service_preference?: string;
  persona_preset?: FirstChatOnboardingPersonaPreset | "custom";
  persona_custom?: string;
  profiling_mode?: ProfilingMode;
  skipped_fields?: string[];
  complete?: boolean;
  locale?: "en" | "ko";
  butlerHome?: string;
}

export interface FirstChatOnboardingUpdateResult {
  ok: true;
  status: FirstChatOnboardingStatus;
  updated_fields: string[];
  skipped_fields: string[];
  profile: {
    has_principal_name: boolean;
    has_preferred_address: boolean;
    has_butler_nickname: boolean;
  };
  persona: {
    preset: string | null;
    applied: boolean;
  };
  profiling: {
    mode: ProfilingMode;
    captured_candidate_count: number;
    raw_text_included: false;
  };
  storage_label: string;
}

const PROFILE_TEXT_LIMIT = 256;
const NOTE_TEXT_LIMIT = 1_000;

function nowIso(): string {
  return new Date().toISOString();
}

export function firstChatOnboardingPath(butlerData: string): string {
  return join(butlerData, FIRST_CHAT_ONBOARDING_STORAGE_LABEL);
}

function defaultState(): FirstChatOnboardingState {
  const now = nowIso();
  return {
    schema: "butler.first_chat_onboarding.v1",
    status: "pending",
    gateway: "any",
    fields: {},
    skipped_fields: [],
    created_at: now,
    updated_at: now,
    completed_at: null,
  };
}

export function readFirstChatOnboardingState(butlerData: string): FirstChatOnboardingState {
  const path = firstChatOnboardingPath(butlerData);
  if (!existsSync(path)) return defaultState();
  try {
    return normalizeState(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return defaultState();
  }
}

export function writeFirstChatOnboardingState(
  butlerData: string,
  state: FirstChatOnboardingState,
): FirstChatOnboardingState {
  const normalized = normalizeState(state);
  const path = firstChatOnboardingPath(butlerData);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return normalized;
}

export function renderFirstChatOnboardingPrompt(input: {
  butlerHome?: string;
  butlerData: string;
  locale?: "en" | "ko";
}): string | null {
  const state = readFirstChatOnboardingState(input.butlerData);
  if (state.status === "complete") return null;
  const locale = input.locale === "ko" ? "ko" : "en";
  const profile = readPersonalizationProfile(input.butlerData);
  const missing = missingOnboardingFields(profile, state);
  const known = knownOnboardingFields(profile, state, locale);
  const presets = personaPresetPromptLines({
    butlerHome: input.butlerHome,
    locale,
  });

  if (locale === "ko") {
    return [
      "첫 대화 온보딩이 아직 완료되지 않았습니다.",
      "이 지침은 설치 단계가 아니라 Butler와 principal의 첫 만남을 위한 대화 지침입니다.",
      "",
      "대화 원칙:",
      "- 설치 마법사처럼 말하지 말고, 처음 만난 사람에게 자연스럽게 묻듯이 친근하고 차분하게 진행합니다.",
      "- 한 번에 하나의 질문만 합니다. 여러 질문을 한 메시지에 몰아서 묻지 않습니다.",
      "- 사용자가 불편해하거나 건너뛰겠다고 하면 존중하고 다음 항목으로 넘어갑니다.",
      "- 사용자의 실제 요청이 함께 있으면 요청을 무시하지 말고 짧게 응답한 뒤 자연스럽게 온보딩을 이어갑니다.",
      "- 사용자가 답한 필드는 `update_onboarding_profile` 도구로 저장합니다.",
      "- 마지막에는 선택된 페르소나를 적용하고 완료 상태를 저장합니다.",
      "",
      "권장 순서:",
      "1. 이름을 묻습니다.",
      "2. 어떻게 불러드리면 좋을지 묻습니다.",
      "3. 좋아하거나 관심 있는 것을 묻습니다. 건너뛰어도 된다고 말합니다.",
      "4. 직업이나 주 분야를 묻습니다. 건너뛰어도 된다고 말합니다.",
      "5. Butler를 뭐라고 부르면 좋을지 묻습니다.",
      "6. 어떻게 대해드리면 좋을지 묻고 아래 페르소나 프리셋 또는 직접 편집을 제안합니다.",
      "7. 장기 사용자 프로필 학습을 허용할지 묻습니다. 선택지는 `off`(사용 안 함), `basic`(명시 답변 중심), `deep`(대화에서 더 넓게 학습)이며, 사용자가 명시적으로 허용하지 않으면 `off`로 저장합니다.",
      "",
      "설정의 페르소나 프리셋 선택지:",
      ...presets,
      "- 직접 편집",
      "",
      known.length > 0 ? `이미 확인된 항목: ${known.join(", ")}` : "이미 확인된 항목: 없음",
      `다음 우선 질문: ${missing[0] ?? "완료 확인"}`,
    ].join("\n");
  }

  return [
    "First-chat onboarding is still pending.",
    "This is not an installer or settings wizard. Treat it as Butler's first natural meeting with the principal.",
    "",
    "Conversation rules:",
    "- Ask like a friendly first meeting, not a form.",
    "- Ask only one question at a time.",
    "- Respect skip answers and move on.",
    "- If the principal also asks for a real task, answer briefly and then continue onboarding naturally.",
    "- Persist confirmed answers with the `update_onboarding_profile` tool.",
    "- At the end, apply the selected persona and mark onboarding complete.",
    "",
    "Recommended order:",
    "1. Ask the principal's name.",
    "2. Ask how Butler should address the principal.",
    "3. Ask what the principal likes or is interested in, with permission to skip.",
    "4. Ask about work, profession, or main field, with permission to skip.",
    "5. Ask what Butler should be called.",
    "6. Ask how Butler should behave, offering persona presets or custom editing.",
    "7. Ask whether Butler may maintain a long-term user profile. Offer `off` (disabled), `basic` (explicit answers only), and `deep` (broader conversation learning). Store `off` unless the principal explicitly accepts profile learning.",
    "",
    "Settings persona preset options:",
    ...presets,
    "- Custom",
    "",
    known.length > 0 ? `Known fields: ${known.join(", ")}` : "Known fields: none",
    `Next priority question: ${missing[0] ?? "completion confirmation"}`,
  ].join("\n");
}

export function updateFirstChatOnboarding(
  butlerData: string,
  input: FirstChatOnboardingUpdate,
): FirstChatOnboardingUpdateResult {
  const state = readFirstChatOnboardingState(butlerData);
  const updatedFields: string[] = [];
  const profileUpdate: PersonalizationProfileUpdate = {};
  const principalName = boundedProfileText(input.principal_name);
  const preferredAddress = boundedProfileText(input.preferred_address);
  const butlerNickname = boundedProfileText(input.butler_nickname);

  if (principalName !== undefined) {
    profileUpdate.principal_name = principalName;
    updatedFields.push("principal_name");
  }
  if (preferredAddress !== undefined) {
    profileUpdate.preferred_address = preferredAddress;
    updatedFields.push("preferred_address");
  }
  if (butlerNickname !== undefined) {
    profileUpdate.butler_nickname = butlerNickname;
    updatedFields.push("butler_nickname");
  }

  const nextFields: FirstChatOnboardingFields = { ...state.fields };
  const interests = boundedNoteText(input.interests);
  const work = boundedNoteText(input.work);
  const servicePreference = boundedNoteText(input.service_preference);
  let personaPreset = normalizePersonaPreset(input.persona_preset);
  const personaCustom = boundedNoteText(input.persona_custom);
  if (!personaPreset && personaCustom) {
    personaPreset = "custom";
  }
  const locale = onboardingLocale(input.locale);
  if (
    personaPreset &&
    personaPreset !== "custom" &&
    input.butlerHome &&
    !readPersonaPreset(input.butlerHome, locale, personaPreset)
  ) {
    personaPreset = null;
  }

  if (interests !== undefined) {
    nextFields.interests = interests;
    updatedFields.push("interests");
  }
  if (work !== undefined) {
    nextFields.work = work;
    updatedFields.push("work");
  }
  if (servicePreference !== undefined) {
    nextFields.service_preference = servicePreference;
    updatedFields.push("service_preference");
  }
  if (personaPreset) {
    nextFields.persona_preset = personaPreset;
    updatedFields.push("persona_preset");
  }
  if (personaCustom !== undefined) {
    nextFields.persona_custom = personaCustom;
    updatedFields.push("persona_custom");
  }
  if (input.profiling_mode !== undefined) {
    nextFields.profiling_mode = normalizeProfilingMode(input.profiling_mode);
    updatedFields.push("profiling_mode");
  }

  const skippedFields = uniqueStrings([
    ...state.skipped_fields,
    ...stringArray(input.skipped_fields),
  ]);

  const profile = Object.keys(profileUpdate).length > 0
    ? updatePersonalizationProfile(butlerData, profileUpdate)
    : readPersonalizationProfile(butlerData);

  let personaApplied = false;
  if (personaPreset && personaPreset !== "custom" && input.butlerHome) {
    personaApplied = applyPersonaPreset({
      butlerHome: input.butlerHome,
      butlerData,
      preset: personaPreset,
      locale,
      butlerName: butlerNickname || profile.butler_nickname || "Butler",
    });
  } else if (personaPreset === "custom" && personaCustom) {
    personaApplied = applyCustomPersona({
      butlerData,
      customText: personaCustom,
      butlerName: butlerNickname || profile.butler_nickname || "Butler",
    });
  }

  const complete = input.complete === true;
  const nextState = writeFirstChatOnboardingState(butlerData, {
    ...state,
    status: complete ? "complete" : state.status,
    fields: nextFields,
    skipped_fields: skippedFields,
    updated_at: nowIso(),
    completed_at: complete ? nowIso() : state.completed_at,
  });

  const explicitProfileText = onboardingObservationText({
    profile,
    fields: nextFields,
  });
  const requestedMode = input.profiling_mode !== undefined
    ? nextFields.profiling_mode ?? "off"
    : readProfilingConsentSnapshot(butlerData).mode;
  const profiling = setProfilingMode(butlerData, requestedMode);
  let capturedCandidateCount = 0;
  if (profiling.mode !== "off" && explicitProfileText) {
    const records = captureProfileCandidatesFromTextObservation(butlerData, {
      text: explicitProfileText,
      evidence_ref: "first-chat-onboarding",
      source_type: "explicit",
      confidence: "high",
      sensitive_domain: false,
      expires_or_decay: "decay",
    });
    capturedCandidateCount = records.length;
    consolidateProfileCandidates(butlerData);
  }

  return {
    ok: true,
    status: nextState.status,
    updated_fields: uniqueStrings(updatedFields).sort(),
    skipped_fields: nextState.skipped_fields,
    profile: {
      has_principal_name: Boolean(profile.principal_name),
      has_preferred_address: Boolean(profile.preferred_address),
      has_butler_nickname: Boolean(profile.butler_nickname),
    },
    persona: {
      preset: personaPreset ?? nextState.fields.persona_preset ?? null,
      applied: personaApplied,
    },
    profiling: {
      mode: profiling.mode,
      captured_candidate_count: capturedCandidateCount,
      raw_text_included: false,
    },
    storage_label: FIRST_CHAT_ONBOARDING_STORAGE_LABEL,
  };
}

function normalizeState(value: unknown): FirstChatOnboardingState {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const fallback = defaultState();
  const fields = input.fields && typeof input.fields === "object" && !Array.isArray(input.fields)
    ? normalizeFields(input.fields as Record<string, unknown>)
    : {};
  return {
    schema: "butler.first_chat_onboarding.v1",
    status: input.status === "complete" ? "complete" : "pending",
    gateway: "any",
    fields,
    skipped_fields: stringArray(input.skipped_fields),
    created_at: typeof input.created_at === "string" ? input.created_at : fallback.created_at,
    updated_at: typeof input.updated_at === "string" ? input.updated_at : fallback.updated_at,
    completed_at: typeof input.completed_at === "string" ? input.completed_at : null,
  };
}

function normalizeFields(input: Record<string, unknown>): FirstChatOnboardingFields {
  const fields: FirstChatOnboardingFields = {};
  const interests = boundedNoteText(input.interests);
  const work = boundedNoteText(input.work);
  const servicePreference = boundedNoteText(input.service_preference);
  const personaPreset = normalizePersonaPreset(input.persona_preset);
  const personaCustom = boundedNoteText(input.persona_custom);
  const profilingMode = typeof input.profiling_mode === "string"
    ? normalizeProfilingMode(input.profiling_mode)
    : undefined;
  if (interests !== undefined) fields.interests = interests;
  if (work !== undefined) fields.work = work;
  if (servicePreference !== undefined) fields.service_preference = servicePreference;
  if (personaPreset) fields.persona_preset = personaPreset;
  if (personaCustom !== undefined) fields.persona_custom = personaCustom;
  if (profilingMode !== undefined) fields.profiling_mode = profilingMode;
  return fields;
}

function missingOnboardingFields(
  profile: PersonalizationProfile,
  state: FirstChatOnboardingState,
): string[] {
  const missing: string[] = [];
  const skipped = new Set(state.skipped_fields);
  if (!profile.principal_name && !skipped.has("principal_name")) missing.push("principal name");
  if (!profile.preferred_address && !skipped.has("preferred_address")) missing.push("preferred address");
  if (!state.fields.interests && !skipped.has("interests")) missing.push("interests");
  if (!state.fields.work && !skipped.has("work")) missing.push("work or main field");
  if (!profile.butler_nickname && !skipped.has("butler_nickname")) missing.push("Butler name");
  if (
    !state.fields.service_preference &&
    !state.fields.persona_preset &&
    !state.fields.persona_custom &&
    !skipped.has("service_preference")
  ) {
    missing.push("desired Butler persona or treatment style");
  }
  if (state.fields.profiling_mode === undefined && !skipped.has("profiling_mode")) {
    missing.push("profile learning consent");
  }
  return missing;
}

function knownOnboardingFields(
  profile: PersonalizationProfile,
  state: FirstChatOnboardingState,
  locale: "en" | "ko",
): string[] {
  const names = locale === "ko"
    ? {
      principal_name: "이름",
      preferred_address: "호칭",
      interests: "관심사",
      work: "주 분야",
      butler_nickname: "Butler 이름",
      service_preference: "대우 방식",
      persona_preset: "페르소나",
      profiling_mode: "프로파일링 동의",
    }
    : {
      principal_name: "name",
      preferred_address: "address",
      interests: "interests",
      work: "work",
      butler_nickname: "Butler name",
      service_preference: "treatment style",
      persona_preset: "persona",
      profiling_mode: "profile learning consent",
    };
  return [
    profile.principal_name ? names.principal_name : "",
    profile.preferred_address ? names.preferred_address : "",
    state.fields.interests ? names.interests : "",
    state.fields.work ? names.work : "",
    profile.butler_nickname ? names.butler_nickname : "",
    state.fields.service_preference ? names.service_preference : "",
    state.fields.persona_preset ? names.persona_preset : "",
    state.fields.profiling_mode !== undefined ? names.profiling_mode : "",
  ].filter(Boolean);
}

function boundedProfileText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return "";
  return value.replace(/\r\n/gu, "\n").trim().slice(0, PROFILE_TEXT_LIMIT);
}

function boundedNoteText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return "";
  return value.replace(/\r\n/gu, "\n").trim().slice(0, NOTE_TEXT_LIMIT);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizePersonaPreset(value: unknown): FirstChatOnboardingPersonaPreset | "custom" | null {
  if (value === "custom") return "custom";
  if (typeof value !== "string") return null;
  return safePersonaPresetName(value);
}

function onboardingObservationText(input: {
  profile: PersonalizationProfile;
  fields: FirstChatOnboardingFields;
}): string {
  return [
    input.profile.principal_name ? `Principal name: ${input.profile.principal_name}` : "",
    input.profile.preferred_address ? `Preferred address: ${input.profile.preferred_address}` : "",
    input.fields.interests ? `Interests: ${input.fields.interests}` : "",
    input.fields.work ? `Work or main field: ${input.fields.work}` : "",
    input.fields.service_preference ? `Preferred treatment style: ${input.fields.service_preference}` : "",
  ].filter(Boolean).join("\n");
}

function readConfig(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  } catch {
    return {};
  }
}

function writeConfig(path: string, config: Record<string, any>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function applyPersonaPreset(input: {
  butlerHome: string;
  butlerData: string;
  preset: FirstChatOnboardingPersonaPreset;
  locale: PersonaPresetLocale;
  butlerName: string;
}): boolean {
  const preset = readPersonaPreset(input.butlerHome, input.locale, input.preset);
  if (!preset) return false;
  const output = preset.content.replace(/\{\{butler_name\}\}/gu, input.butlerName);
  const activePath = join(input.butlerData, "personas", "active.md");
  mkdirSync(dirname(activePath), { recursive: true, mode: 0o700 });
  writeFileSync(activePath, output.endsWith("\n") ? output : `${output}\n`, { mode: 0o600 });

  const configPath = join(input.butlerData, "butler.config.json");
  const config = readConfig(configPath);
  config.butler = config.butler && typeof config.butler === "object" ? config.butler : {};
  config.butler.name = input.butlerName;
  config.system = config.system && typeof config.system === "object" ? config.system : {};
  config.system.activePersona = input.preset;
  config.system.activePersonaLocale = preset.locale;
  writeConfig(configPath, config);
  return true;
}

function applyCustomPersona(input: {
  butlerData: string;
  customText: string;
  butlerName: string;
}): boolean {
  const activePath = join(input.butlerData, "personas", "active.md");
  mkdirSync(dirname(activePath), { recursive: true, mode: 0o700 });
  writeFileSync(activePath, [
    "---",
    "name: active",
    "description: Custom persona copied from first-chat onboarding.",
    "base: custom",
    "---",
    `# ${input.butlerName}`,
    "",
    "Use this principal-provided treatment and voice preference:",
    "",
    input.customText,
    "",
  ].join("\n"), { mode: 0o600 });

  const configPath = join(input.butlerData, "butler.config.json");
  const config = readConfig(configPath);
  config.butler = config.butler && typeof config.butler === "object" ? config.butler : {};
  config.butler.name = input.butlerName;
  config.system = config.system && typeof config.system === "object" ? config.system : {};
  config.system.activePersona = "custom";
  config.system.activePersonaLocale = "custom";
  writeConfig(configPath, config);
  return true;
}

function onboardingLocale(value: unknown): PersonaPresetLocale {
  return value === "ko" ? "ko" : "en";
}

function personaPresetPromptLines(input: {
  butlerHome?: string;
  locale: PersonaPresetLocale;
}): string[] {
  if (!input.butlerHome) return [];
  return readPersonaPresets(input.butlerHome, input.locale).map((preset) => {
    return preset.preview
      ? `- ${preset.label} - ${preset.preview}`
      : `- ${preset.label}`;
  });
}
