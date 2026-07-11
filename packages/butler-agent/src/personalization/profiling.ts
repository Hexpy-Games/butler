import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_MODEL_REF,
  DEFAULT_REASONING_EFFORT,
  type ReasoningEffort,
} from "../integrations/providers/model-catalog.ts";
import { parseModelRef } from "../integrations/providers/model-ref.ts";
import {
  runPromptTextWithUsage,
  type PromptUsageReport,
} from "../integrations/providers/provider.ts";
import { readConversationObservations } from "../agent/cognition/memory/scripts/lib/conversation-sources.ts";

export type ProfilingMode = "off" | "basic" | "deep";
export type ProfileCandidateCategory =
  | "identity"
  | "cares"
  | "values"
  | "narrative"
  | "agency"
  | "epistemic_style"
  | "communication"
  | "affective_landscape"
  | "relationships"
  | "aesthetics"
  | "boundaries";
export type ProfileSourceType =
  | "explicit"
  | "repeated_observation"
  | "inference"
  | "user_confirmed";
export type ProfileConfidence = "low" | "medium" | "high";
export type ProfileCandidateStatus = "candidate" | "promoted" | "rejected" | "expired";
export type ProfileFacet =
  | "self_descriptions"
  | "roles"
  | "commitments"
  | "current_interests"
  | "enduring_interests"
  | "meaningful_objects"
  | "explicit_values"
  | "inferred_values"
  | "disliked_values"
  | "meaningful_events"
  | "turning_points"
  | "unresolved_threads"
  | "goals"
  | "active_projects"
  | "tensions"
  | "avoidance_patterns"
  | "how_the_user_thinks"
  | "evidence_preference"
  | "uncertainty_tolerance"
  | "correction_style"
  | "tone_preference"
  | "explanation_preference"
  | "emotional_mode"
  | "energizers"
  | "frustrations"
  | "comfort_patterns"
  | "important_people_or_groups"
  | "collaboration_preferences"
  | "social_boundaries"
  | "taste"
  | "anti_taste"
  | "quality_sense"
  | "privacy_rules"
  | "consent_required"
  | "sensitive_domains";
export type ProfileLayer =
  | "stable_disposition"
  | "contextual_adaptation"
  | "current_attention"
  | "narrative_meaning";
export type ProfileTemporalScope = "transient" | "active" | "durable";
export type ProfileDecayPolicy = "days_7" | "days_30" | "reinforce_or_decay" | "never_without_consent";
export type ProfileSensitivity = "normal" | "sensitive" | "restricted";

export interface RuntimeProfileProjection {
  version: number;
  mode: Exclude<ProfilingMode, "off">;
  updated_at: string;
  how_to_answer: string[];
  how_to_collaborate: string[];
  response_hints: string[];
  current_attention: string[];
  active_boundaries: string[];
  likely_failure_modes: string[];
  ask_before: string[];
  caution_hints: string[];
}

export interface ProfilingConsentSnapshot {
  mode: ProfilingMode;
  consent_version: string;
  consented_at: string | null;
  raw_profile_browser_visible: false;
}

export interface ProfileCandidateInput {
  layer?: ProfileLayer | null;
  category: ProfileCandidateCategory;
  facet?: ProfileFacet | null;
  summary: string;
  applies_when?: string[];
  butler_should?: string[];
  butler_should_not?: string[];
  temporal_scope?: ProfileTemporalScope | null;
  decay_policy?: ProfileDecayPolicy | null;
  contradiction_refs?: string[];
  sensitivity?: ProfileSensitivity | null;
  source_type: ProfileSourceType;
  confidence: ProfileConfidence;
  evidence_ref?: string | null;
  sensitive_domain?: boolean;
  expires_or_decay?: "expires" | "decay" | null;
  now?: Date;
}

export interface ProfileCandidateRecord {
  id: string;
  layer: ProfileLayer;
  category: ProfileCandidateCategory;
  facet: ProfileFacet | null;
  summary: string;
  applies_when: string[];
  butler_should: string[];
  butler_should_not: string[];
  temporal_scope: ProfileTemporalScope;
  decay_policy: ProfileDecayPolicy;
  contradiction_refs: string[];
  sensitivity: ProfileSensitivity;
  evidence_refs: string[];
  evidence_count: number;
  source_type: ProfileSourceType;
  confidence: ProfileConfidence;
  sensitive_domain: boolean;
  status: ProfileCandidateStatus;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  expires_or_decay: "expires" | "decay" | null;
  promoted_at: string | null;
}

export interface StableProfileEntry {
  id: string;
  layer: ProfileLayer;
  category: ProfileCandidateCategory;
  facet: ProfileFacet | null;
  summary: string;
  applies_when: string[];
  butler_should: string[];
  butler_should_not: string[];
  temporal_scope: ProfileTemporalScope;
  decay_policy: ProfileDecayPolicy;
  contradiction_refs: string[];
  sensitivity: ProfileSensitivity;
  evidence_refs: string[];
  evidence_count: number;
  source_type: ProfileSourceType;
  confidence: ProfileConfidence;
  sensitive_domain: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProfileFeedbackInput {
  feedback_id: string;
  category: string;
  promotion_target: string;
  target_ref: string;
  text: string;
  created_at?: string;
  privacy_class?: string;
}

export interface ProfileTextObservationInput {
  text: string;
  evidence_ref?: string | null;
  source_type?: ProfileSourceType;
  confidence?: ProfileConfidence;
  sensitive_domain?: boolean;
  expires_or_decay?: "expires" | "decay" | null;
  now?: Date;
}

export interface ProfileTranscriptCaptureOptions {
  maxFiles?: number;
  maxUserMessages?: number;
  since?: string | Date | null;
}

export interface ProfileExtractorModelRunnerInput {
  model: string;
  reasoningEffort: ReasoningEffort;
  instructions: string;
  prompt: string;
  cacheScope: string;
  butlerData?: string;
  signal?: AbortSignal;
}

export interface ProfileExtractorModelRunnerResult {
  text: string;
  usage?: PromptUsageReport | null;
  model?: string | null;
}

export type ProfileExtractorModelRunner = (
  input: ProfileExtractorModelRunnerInput,
) => Promise<string | ProfileExtractorModelRunnerResult>;

let configuredProfileExtractorModelRunner: ProfileExtractorModelRunner | null = async (input) =>
  await runPromptTextWithUsage({
    prompt: input.prompt,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    instructions: input.instructions,
    cacheScope: input.cacheScope,
    butlerData: input.butlerData,
    signal: input.signal,
  });

export function setDefaultProfileExtractorModelRunner(
  runner: ProfileExtractorModelRunner | null,
): void {
  configuredProfileExtractorModelRunner = runner;
}

function emptyProfileModelUsage(): ProfileModelUsageSummary {
  return {
    request_count: 0,
    prompt_tokens: 0,
    cached_input_tokens: 0,
    uncached_input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    models: [],
  };
}

function addProfileModelUsage(
  summary: ProfileModelUsageSummary,
  input: { model: string; usage?: PromptUsageReport | null },
): void {
  summary.request_count += 1;
  const model = input.usage?.model || input.model;
  if (model && !summary.models.includes(model)) summary.models.push(model);
  const promptTokens = input.usage?.promptTokens;
  const cachedTokens = input.usage?.cachedTokens ?? 0;
  const totalTokens = input.usage?.totalTokens;
  if (typeof promptTokens === "number") {
    summary.prompt_tokens += promptTokens;
    summary.cached_input_tokens += Math.min(cachedTokens, promptTokens);
    summary.uncached_input_tokens += Math.max(0, promptTokens - cachedTokens);
  }
  if (typeof totalTokens === "number") {
    summary.total_tokens += totalTokens;
    if (typeof promptTokens === "number") {
      summary.output_tokens += Math.max(0, totalTokens - promptTokens);
    }
  }
}

function normalizeProfileExtractorOutput(
  output: string | ProfileExtractorModelRunnerResult,
): ProfileExtractorModelRunnerResult {
  return typeof output === "string" ? { text: output } : output;
}

export interface ProfileModelTranscriptCaptureOptions extends ProfileTranscriptCaptureOptions {
  model?: string | null;
  modelRunner?: ProfileExtractorModelRunner;
  maxModelBatches?: number;
  cacheScope?: string;
  signal?: AbortSignal;
}

export interface ProfileTranscriptCaptureResult {
  profiling_enabled: boolean;
  mode: ProfilingMode;
  scanned_file_count: number;
  scanned_event_count: number;
  semantic_scanned_session_count: number;
  semantic_scanned_message_count: number;
  audit_transcript_scanned_file_count: number;
  audit_transcript_scanned_event_count: number;
  captured_candidate_count: number;
  raw_text_included: false;
}

export interface ProfileModelTranscriptCaptureResult extends ProfileTranscriptCaptureResult {
  extractor_model: ProfilingExtractorModelSnapshot;
  model_called: boolean;
  fallback_used: boolean;
  model_usage: ProfileModelUsageSummary;
  model_error?: string;
}

export interface ProfileModelUsageSummary {
  request_count: number;
  prompt_tokens: number;
  cached_input_tokens: number;
  uncached_input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  models: string[];
}

export interface ProfileThirdPartyImportOptions {
  source?: string | null;
  text: string;
  model?: string | null;
  modelRunner?: ProfileExtractorModelRunner;
  signal?: AbortSignal;
  now?: Date;
}

export interface ProfileThirdPartyImportResult {
  profiling_enabled: boolean;
  mode: ProfilingMode;
  source: string;
  import_id: string | null;
  imported_candidate_count: number;
  promoted_count: number;
  skipped_count: number;
  stable_entry_count: number;
  projection_written: boolean;
  raw_text_included: false;
  extractor_model: ProfilingExtractorModelSnapshot;
  model_called: boolean;
  fallback_used: false;
  model_error?: string;
}

export interface ProfileConsolidationResult {
  profiling_enabled: boolean;
  mode: ProfilingMode;
  candidate_count: number;
  promoted_count: number;
  skipped_count: number;
  rejected_count: number;
  stable_entry_count: number;
  projection_written: boolean;
  raw_text_included: false;
}

export interface ReflectiveProfileSummary {
  ok: true;
  profiling_enabled: boolean;
  mode: ProfilingMode;
  entry_count: number;
  summary: string;
  bullets: string[];
  raw_profile_included: false;
}

export const PROFILE_BLACK_BOX_STORAGE_LABEL = "cognition/profile/profile.sqlite";
export const PROFILE_CONSENT_VERSION = "2026-05-16";
export const PROFILE_PROJECTION_TOKEN_BUDGET = 500;
export const PROFILE_EXTRACTOR_MODEL_DEFAULT = "default";

export interface ProfilingExtractorModelSnapshot {
  configured_model: string | null;
  reasoning_effort: ReasoningEffort;
  effective_model: string;
  uses_butler_model: boolean;
}

const MAX_HINTS_PER_GROUP = 6;
const MAX_HINT_CHARS = 240;
const MAX_SUMMARY_CHARS = 320;
const DEFAULT_PROFILE_TRANSCRIPT_MAX_FILES = 200;
const DEFAULT_PROFILE_TRANSCRIPT_MAX_USER_MESSAGES = 1_200;
const DEFAULT_PROFILE_EXTRACTION_BATCHES = 8;
const MAX_PROFILE_TRANSCRIPT_FILES = 1_000;
const MAX_PROFILE_TRANSCRIPT_USER_MESSAGES = 20_000;
const MAX_PROFILE_EXTRACTION_BATCHES = 120;
const MAX_MODEL_OBSERVATIONS = 160;
const MAX_MODEL_OBSERVATION_CHARS = 900;
const MAX_PROFILE_EXTRACTION_PROMPT_CHARS = 28_000;
const MAX_PROFILE_IMPORT_TEXT_CHARS = 60_000;
const MAX_PROFILE_IMPORT_PROMPT_TEXT_CHARS = 18_000;
const BASIC_PROFILE_CATEGORIES = new Set<ProfileCandidateCategory>([
  "communication",
  "epistemic_style",
  "boundaries",
]);

export function profileBlackBoxPath(butlerData: string): string {
  return join(butlerData, PROFILE_BLACK_BOX_STORAGE_LABEL);
}

export function normalizeProfilingMode(value: unknown): ProfilingMode {
  return value === "basic" || value === "deep" ? value : "off";
}

export function readProfilingExtractorModelConfig(
  butlerData: string,
): ProfilingExtractorModelSnapshot {
  const config = readButlerConfigJson(butlerData);
  const configured = normalizeProfilingExtractorModelRef(
    config.personalization?.profiling?.extractorModel,
  );
  const butlerModel =
    readAppSettingsModelRef(butlerData) ??
    normalizeButlerModelRef(config) ??
    DEFAULT_MODEL_REF;
  const explicitModel = configured && configured !== PROFILE_EXTRACTOR_MODEL_DEFAULT
    ? configured
    : null;
  const reasoningEffort =
    normalizeProfilingExtractorReasoningEffort(
      config.personalization?.profiling?.extractorReasoningEffort,
    ) ??
    readAppSettingsReasoningEffort(butlerData) ??
    DEFAULT_REASONING_EFFORT;
  return {
    configured_model: explicitModel,
    reasoning_effort: reasoningEffort,
    effective_model: explicitModel ?? butlerModel,
    uses_butler_model: explicitModel === null,
  };
}

export function setProfilingExtractorModel(
  butlerData: string,
  modelRef: string | null | undefined,
): ProfilingExtractorModelSnapshot {
  return setProfilingExtractorModelConfig(butlerData, { modelRef });
}

export function setProfilingExtractorReasoningEffort(
  butlerData: string,
  reasoningEffort: ReasoningEffort | null | undefined,
): ProfilingExtractorModelSnapshot {
  return setProfilingExtractorModelConfig(butlerData, { reasoningEffort });
}

function setProfilingExtractorModelConfig(
  butlerData: string,
  input: {
    modelRef?: string | null;
    reasoningEffort?: ReasoningEffort | null;
  },
): ProfilingExtractorModelSnapshot {
  const config = readButlerConfigJson(butlerData);
  config.personalization = normalizeJsonObject(config.personalization);
  config.personalization.profiling = normalizeJsonObject(config.personalization.profiling);
  if ("modelRef" in input) {
    const normalizedModel = normalizeProfilingExtractorModelRef(input.modelRef);
    config.personalization.profiling.extractorModel =
      normalizedModel && normalizedModel !== PROFILE_EXTRACTOR_MODEL_DEFAULT
        ? normalizedModel
        : PROFILE_EXTRACTOR_MODEL_DEFAULT;
  }
  if ("reasoningEffort" in input) {
    config.personalization.profiling.extractorReasoningEffort =
      normalizeProfilingExtractorReasoningEffort(input.reasoningEffort) ??
      DEFAULT_REASONING_EFFORT;
  }
  writeButlerConfigJsonAtomic(butlerData, config);
  return readProfilingExtractorModelConfig(butlerData);
}

export function ensureProfileBlackBoxStore(butlerData: string): void {
  const db = openProfileDb(butlerData, true);
  db.close();
}

export function readProfilingConsentSnapshot(
  butlerData: string,
): ProfilingConsentSnapshot {
  if (!existsSync(profileBlackBoxPath(butlerData))) {
    return defaultProfilingConsentSnapshot();
  }
  const db = openProfileDb(butlerData, false);
  try {
    const rows = db.query(`
      SELECT key, value_json
      FROM profile_meta
    `).all() as Array<{ key: string; value_json: string }>;
    const values = new Map<string, unknown>();
    for (const row of rows) {
      try {
        values.set(row.key, JSON.parse(row.value_json));
      } catch {
        values.set(row.key, null);
      }
    }
    const mode = normalizeProfilingMode(values.get("mode"));
    return {
      mode,
      consent_version: typeof values.get("consent_version") === "string"
        ? values.get("consent_version") as string
        : PROFILE_CONSENT_VERSION,
      consented_at: mode === "off"
        ? null
        : typeof values.get("consented_at") === "string"
          ? values.get("consented_at") as string
          : null,
      raw_profile_browser_visible: false,
    };
  } catch {
    return defaultProfilingConsentSnapshot();
  } finally {
    db.close();
  }
}

export function isProfilingEnabled(butlerData: string): boolean {
  return readProfilingConsentSnapshot(butlerData).mode !== "off";
}

export function writeProfilingConsentSnapshot(
  butlerData: string,
  input: Partial<ProfilingConsentSnapshot> & { mode: ProfilingMode },
): ProfilingConsentSnapshot {
  const now = new Date().toISOString();
  const mode = normalizeProfilingMode(input.mode);
  const snapshot: ProfilingConsentSnapshot = {
    mode,
    consent_version: input.consent_version ?? PROFILE_CONSENT_VERSION,
    consented_at: mode === "off" ? null : input.consented_at ?? now,
    raw_profile_browser_visible: false,
  };
  const db = openProfileDb(butlerData, true);
  try {
    const stmt = db.prepare(`
      INSERT INTO profile_meta (key, value_json, updated_at)
      VALUES ($key, $value_json, $updated_at)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `);
    for (const [key, value] of Object.entries(snapshot)) {
      stmt.run({
        $key: key,
        $value_json: JSON.stringify(value),
        $updated_at: now,
      });
    }
    if (mode === "off") deleteRuntimeProfileProjectionInDb(db);
  } finally {
    db.close();
  }
  return snapshot;
}

export function setProfilingMode(
  butlerData: string,
  mode: ProfilingMode,
): ProfilingConsentSnapshot {
  return writeProfilingConsentSnapshot(butlerData, { mode });
}

export function clearProfilingData(butlerData: string): {
  removed_candidates: number;
  removed_stable_entries: number;
  removed_runtime_projections: number;
} {
  const db = openProfileDb(butlerData, true);
  try {
    const candidateCount = countRows(db, "profile_candidates");
    const stableCount = countRows(db, "stable_profile_entries");
    const projectionCount = countRows(db, "runtime_projection");
    db.exec(`
      DELETE FROM profile_candidates;
      DELETE FROM stable_profile_entries;
      DELETE FROM runtime_projection;
    `);
    return {
      removed_candidates: candidateCount,
      removed_stable_entries: stableCount,
      removed_runtime_projections: projectionCount,
    };
  } finally {
    db.close();
  }
}

export function profileThirdPartyMigrationPrompt(locale: "en" | "ko" = "en"): string {
  if (locale === "ko") {
    return [
      "지금까지 나에 대해 저장한 모든 기억과, 과거 대화에서 안정적으로 알게 된 장기 맥락을 내보내 주세요.",
      "가능하면 내 표현을 그대로 보존해 주세요. 특히 지시사항, 선호, 교정 요청은 원문에 가깝게 남겨 주세요.",
      "",
      "## Categories",
      "",
      "아래 순서와 섹션 이름을 그대로 사용해 주세요.",
      "",
      "1. **Instructions**: 앞으로 계속 따르라고 내가 명시적으로 요청한 규칙입니다. 말투, 형식, 스타일, \"항상 X\", \"절대 Y\", 행동 교정 요청을 포함합니다. 저장된 기억에 있는 규칙만 포함하고, 현재 대화에서 새로 추론한 규칙은 포함하지 마세요.",
      "",
      "2. **Identity**: 이름, 나이, 위치, 교육, 가족, 관계, 언어, 개인적 관심사처럼 오래 유지되는 자기 맥락입니다.",
      "",
      "3. **Career**: 현재/과거 역할, 회사, 업무 영역, 기술 스택, 일반적인 역량입니다.",
      "",
      "4. **Projects**: 내가 의미 있게 만들었거나 장기적으로 책임지고 있는 프로젝트입니다. 가능하면 프로젝트당 한 줄로 쓰고, 각 항목의 첫 단어는 프로젝트명 또는 짧은 식별자로 시작하세요. 무엇을 하는지, 현재 상태, 중요한 결정이 있으면 포함해 주세요.",
      "",
      "5. **Interests and Meaningful Context**: 최근 반복적으로 관심을 보인 주제, 오래 지속되는 관심사, 의미 있었던 사건이나 방향 전환입니다.",
      "",
      "6. **Preferences**: 넓게 적용되는 의견, 취향, 작업 방식, 설명 방식, 협업 방식, 검증 기대입니다.",
      "",
      "7. **Boundaries and Uncertainties**: 피해야 할 것, 민감한 영역, 확신이 낮은 추론입니다. 추론은 반드시 추론이라고 표시하세요.",
      "",
      "## Format",
      "",
      "각 범주는 섹션 헤더로 구분하고, 각 범주 안에는 한 줄에 한 항목만 적어 주세요. 오래된 날짜부터 최신 날짜 순서로 정렬하세요.",
      "",
      "각 줄은 다음 형식을 사용해 주세요:",
      "",
      "[YYYY-MM-DD] - 항목 내용",
      "",
      "날짜를 모르면 [unknown]을 사용하세요.",
      "",
      "## Output",
      "",
      "- 전체 export를 복사하기 쉽도록 하나의 코드 블록으로 감싸 주세요.",
      "- 코드 블록 뒤에는 이것이 완전한 전체 목록인지, 아니면 더 남아 있는지 한 문장으로 밝혀 주세요.",
      "- 비밀번호, 토큰, 인증키, 결제정보 같은 비밀은 절대 포함하지 마세요.",
      "",
      "출력 예시:",
      "```",
      "## Instructions",
      "[unknown] - ...",
      "",
      "## Identity",
      "[unknown] - ...",
      "```",
    ].join("\n");
  }
  return [
    "Export all of my stored memories and any durable context you've reliably learned about me from past conversations.",
    "Preserve my words verbatim where possible, especially for instructions, preferences, and corrections to your behavior.",
    "",
    "## Categories",
    "",
    "Use these section names and this order.",
    "",
    '1. **Instructions**: Rules I explicitly asked you to follow going forward: tone, format, style, "always do X", "never do Y", and corrections to your behavior. Only include rules from stored memories, not new inferences from this conversation.',
    "",
    "2. **Identity**: Name, age, location, education, family, relationships, languages, and personal interests.",
    "",
    "3. **Career**: Current and past roles, companies, work areas, technical stack, and general skill areas.",
    "",
    "4. **Projects**: Projects I meaningfully built or committed to. Ideally use one entry per project. Start each entry with the project name or a short descriptor, then include what it does, current status, and key decisions when known.",
    "",
    "5. **Interests and Meaningful Context**: Recent recurring interests, enduring interests, meaningful events, and turning points.",
    "",
    "6. **Preferences**: Opinions, tastes, working-style preferences, explanation preferences, collaboration preferences, and verification expectations that apply broadly.",
    "",
    "7. **Boundaries and Uncertainties**: Things to avoid, sensitive areas, and low-confidence inferences. Clearly label inferences as inference.",
    "",
    "## Format",
    "",
    "Use section headers for each category. Within each category, list one entry per line, sorted by oldest date first.",
    "",
    "Format each line as:",
    "",
    "[YYYY-MM-DD] - Entry content here.",
    "",
    "If no date is known, use [unknown] instead.",
    "",
    "## Output",
    "",
    "- Wrap the entire export in a single code block for easy copying.",
    "- After the code block, state whether this is the complete set or if more remain.",
    "- Never include passwords, tokens, API keys, payment data, or other secrets.",
    "",
    "Example:",
    "```",
    "## Instructions",
    "[unknown] - ...",
    "",
    "## Identity",
    "[unknown] - ...",
    "```",
  ].join("\n");
}

export async function importProfileCandidatesFromThirdPartyDumpWithModel(
  butlerData: string,
  options: ProfileThirdPartyImportOptions,
): Promise<ProfileThirdPartyImportResult> {
  const source = normalizeProfileImportSource(options.source);
  const extractorModel = readProfilingExtractorModelConfig(butlerData);
  const consent = readProfilingConsentSnapshot(butlerData);
  if (consent.mode === "off") {
    return {
      profiling_enabled: false,
      mode: "off",
      source,
      import_id: null,
      imported_candidate_count: 0,
      promoted_count: 0,
      skipped_count: 0,
      stable_entry_count: listStableProfileEntries(butlerData).length,
      projection_written: false,
      raw_text_included: false,
      extractor_model: extractorModel,
      model_called: false,
      fallback_used: false,
    };
  }

  const text = normalizeProfileImportText(options.text);
  const importHash = profileImportHash(source, text);
  const importId = `third_party_profile_import:${source}:${importHash}`;
  if (!text) {
    return {
      profiling_enabled: true,
      mode: consent.mode,
      source,
      import_id: importId,
      imported_candidate_count: 0,
      promoted_count: 0,
      skipped_count: 0,
      stable_entry_count: listStableProfileEntries(butlerData).length,
      projection_written: false,
      raw_text_included: false,
      extractor_model: extractorModel,
      model_called: false,
      fallback_used: false,
    };
  }

  const model = options.model?.trim()
    ? parseModelRef(options.model).canonicalRef
    : extractorModel.effective_model;
  const runner = options.modelRunner ?? defaultProfileExtractorModelRunner;
  const now = iso(options.now);
  const raw = normalizeProfileExtractorOutput(await runner({
    model,
    reasoningEffort: extractorModel.reasoning_effort,
    instructions: [
      profileExtractorInstructions(consent.mode),
      "The input is a user-provided export from another AI assistant, not a Butler transcript.",
      "Treat claims as third-party imported profile candidates. Prefer source_type inference unless the export clearly says the user explicitly stated or confirmed the point.",
      "Do not copy raw import text into summaries.",
    ].join("\n"),
    prompt: profileThirdPartyImportExtractorPrompt({
      source,
      importId,
      text,
      mode: consent.mode,
      importedAt: now,
    }),
    cacheScope: "profile-extractor",
    butlerData,
    signal: options.signal,
  }));
  const candidates = parseProfileExtractorResponse(
    raw.text,
    new Set([importId]),
    consent.mode,
  );
  const capturedCandidateIds = new Set<string>();
  for (const candidate of candidates) {
    const record = upsertProfileCandidate(butlerData, {
      layer: candidate.layer,
      category: candidate.category,
      facet: candidate.facet,
      summary: candidate.summary,
      applies_when: candidate.applies_when,
      butler_should: candidate.butler_should,
      butler_should_not: candidate.butler_should_not,
      temporal_scope: candidate.temporal_scope,
      decay_policy: candidate.decay_policy,
      contradiction_refs: candidate.contradiction_refs,
      sensitivity: candidate.sensitivity,
      source_type: candidate.source_type,
      confidence: candidate.confidence,
      evidence_ref: importId,
      sensitive_domain: candidate.sensitive_domain,
      expires_or_decay: candidate.expires_or_decay,
      now: options.now,
    });
    if (record) capturedCandidateIds.add(record.id);
  }
  const consolidation = consolidateProfileCandidates(butlerData);
  writeProfileImportManifest(butlerData, {
    import_id: importId,
    source,
    imported_at: now,
    text_sha256: importHash,
    input_chars: text.length,
    candidate_ids: [...capturedCandidateIds].sort(),
    raw_text_included: false,
  });
  return {
    profiling_enabled: true,
    mode: consent.mode,
    source,
    import_id: importId,
    imported_candidate_count: capturedCandidateIds.size,
    promoted_count: consolidation.promoted_count,
    skipped_count: consolidation.skipped_count,
    stable_entry_count: consolidation.stable_entry_count,
    projection_written: consolidation.projection_written,
    raw_text_included: false,
    extractor_model: { ...extractorModel, effective_model: model },
    model_called: true,
    fallback_used: false,
  };
}

export function upsertProfileCandidate(
  butlerData: string,
  input: ProfileCandidateInput,
): ProfileCandidateRecord | null {
  const consent = readProfilingConsentSnapshot(butlerData);
  if (consent.mode === "off") return null;
  if (!categoryAllowedInMode(input.category, consent.mode)) return null;
  const now = iso(input.now);
  const summary = normalizeSummary(input.summary);
  if (!summary) return null;
  const facet = normalizeProfileFacet(input.facet);
  const evidenceRef = normalizeEvidenceRef(input.evidence_ref);
  const id = profileCandidateId(input.category, facet, summary);
  const db = openProfileDb(butlerData, true);
  try {
    const existing = readProfileCandidateFromDb(db, id);
    const evidenceRefs = uniqueStrings([
      ...(existing?.evidence_refs ?? []),
      ...(evidenceRef ? [evidenceRef] : []),
    ]);
    const sensitiveDomain = normalizeProfileSensitiveDomain({
      category: input.category,
      facet: facet ?? existing?.facet ?? null,
      summary,
      declaredSensitive: Boolean(input.sensitive_domain || existing?.sensitive_domain),
    });
    const normalizedInput = {
      ...input,
      sensitive_domain: sensitiveDomain,
      sensitivity: sensitiveDomain ? input.sensitivity : "normal",
    };
    const record: ProfileCandidateRecord = {
      id,
      category: input.category,
      facet: facet ?? existing?.facet ?? null,
      summary,
      evidence_refs: evidenceRefs,
      evidence_count: Math.max(evidenceRefs.length, existing?.evidence_count ?? 0, evidenceRef ? 1 : 0),
      source_type: strongerSourceType(existing?.source_type, input.source_type),
      confidence: strongerConfidence(existing?.confidence, input.confidence),
      sensitive_domain: sensitiveDomain,
      status: existing?.status === "promoted" ? "promoted" : "candidate",
      created_at: existing?.created_at ?? now,
      updated_at: now,
      last_seen_at: now,
      expires_or_decay: input.expires_or_decay ?? existing?.expires_or_decay ?? null,
      promoted_at: existing?.promoted_at ?? null,
      ...mergeProfileUnderstandingFields(existing, normalizedInput),
    };
    writeProfileCandidateInDb(db, record);
    return record;
  } finally {
    db.close();
  }
}

export function listProfileCandidates(
  butlerData: string,
): ProfileCandidateRecord[] {
  if (!existsSync(profileBlackBoxPath(butlerData))) return [];
  const db = openProfileDb(butlerData, false);
  try {
    const rows = db.query(`
      SELECT *
      FROM profile_candidates
      ORDER BY updated_at DESC, id ASC
    `).all() as ProfileCandidateRow[];
    return rows.map(recordFromCandidateRow).filter(Boolean) as ProfileCandidateRecord[];
  } finally {
    db.close();
  }
}

export function listStableProfileEntries(
  butlerData: string,
): StableProfileEntry[] {
  if (!existsSync(profileBlackBoxPath(butlerData))) return [];
  const db = openProfileDb(butlerData, false);
  try {
    const rows = db.query(`
      SELECT *
      FROM stable_profile_entries
      ORDER BY updated_at DESC, id ASC
    `).all() as StableProfileRow[];
    return rows.map(recordFromStableRow).filter(Boolean) as StableProfileEntry[];
  } finally {
    db.close();
  }
}

export function captureProfileCandidatesFromFeedback(
  butlerData: string,
  feedback: ProfileFeedbackInput,
): ProfileCandidateRecord[] {
  void butlerData;
  void feedback;
  return [];
}

export function captureProfileCandidatesFromTextObservation(
  butlerData: string,
  observation: ProfileTextObservationInput,
): ProfileCandidateRecord[] {
  void butlerData;
  void observation;
  return [];
}

export function captureProfileCandidatesFromTranscripts(
  butlerData: string,
  options: ProfileTranscriptCaptureOptions = {},
): ProfileTranscriptCaptureResult {
  const consent = readProfilingConsentSnapshot(butlerData);
  if (consent.mode === "off") {
    return {
      profiling_enabled: false,
      mode: "off",
      scanned_file_count: 0,
      scanned_event_count: 0,
      semantic_scanned_session_count: 0,
      semantic_scanned_message_count: 0,
      audit_transcript_scanned_file_count: 0,
      audit_transcript_scanned_event_count: 0,
      captured_candidate_count: 0,
      raw_text_included: false,
    };
  }

  const transcriptRead = readProfileConversationObservations(butlerData, consent, options);

  return {
    profiling_enabled: true,
    mode: consent.mode,
    scanned_file_count: transcriptRead.scanned_file_count,
    scanned_event_count: transcriptRead.scanned_event_count,
    semantic_scanned_session_count: transcriptRead.semantic_scanned_session_count,
    semantic_scanned_message_count: transcriptRead.semantic_scanned_message_count,
    audit_transcript_scanned_file_count: transcriptRead.audit_transcript_scanned_file_count,
    audit_transcript_scanned_event_count: transcriptRead.audit_transcript_scanned_event_count,
    captured_candidate_count: 0,
    raw_text_included: false,
  };
}

export async function captureProfileCandidatesFromTranscriptsWithModel(
  butlerData: string,
  options: ProfileModelTranscriptCaptureOptions = {},
): Promise<ProfileModelTranscriptCaptureResult> {
  const extractorModel = readProfilingExtractorModelConfig(butlerData);
  const consent = readProfilingConsentSnapshot(butlerData);
  if (consent.mode === "off") {
    return {
      profiling_enabled: false,
      mode: "off",
      scanned_file_count: 0,
      scanned_event_count: 0,
      semantic_scanned_session_count: 0,
      semantic_scanned_message_count: 0,
      audit_transcript_scanned_file_count: 0,
      audit_transcript_scanned_event_count: 0,
      captured_candidate_count: 0,
      raw_text_included: false,
      extractor_model: extractorModel,
      model_called: false,
      fallback_used: false,
      model_usage: emptyProfileModelUsage(),
    };
  }

  const transcriptRead = readProfileConversationObservations(butlerData, consent, options);
  if (transcriptRead.observations.length === 0) {
    return {
      profiling_enabled: true,
      mode: consent.mode,
      scanned_file_count: transcriptRead.scanned_file_count,
      scanned_event_count: transcriptRead.scanned_event_count,
      semantic_scanned_session_count: transcriptRead.semantic_scanned_session_count,
      semantic_scanned_message_count: transcriptRead.semantic_scanned_message_count,
      audit_transcript_scanned_file_count: transcriptRead.audit_transcript_scanned_file_count,
      audit_transcript_scanned_event_count: transcriptRead.audit_transcript_scanned_event_count,
      captured_candidate_count: 0,
      raw_text_included: false,
      extractor_model: extractorModel,
      model_called: false,
      fallback_used: false,
      model_usage: emptyProfileModelUsage(),
    };
  }

  const model = options.model?.trim()
    ? parseModelRef(options.model).canonicalRef
    : extractorModel.effective_model;
  const runner = options.modelRunner ?? defaultProfileExtractorModelRunner;
  try {
    const maxBatches = Math.max(
      1,
      Math.min(options.maxModelBatches ?? DEFAULT_PROFILE_EXTRACTION_BATCHES, MAX_PROFILE_EXTRACTION_BATCHES),
    );
    const batches = profileExtractionObservationBatches(transcriptRead.observations, maxBatches);
    const capturedCandidateIds = new Set<string>();
    const modelUsage = emptyProfileModelUsage();
    for (const batch of batches) {
      const raw = normalizeProfileExtractorOutput(await runner({
        model,
        reasoningEffort: extractorModel.reasoning_effort,
        instructions: profileExtractorInstructions(consent.mode),
        prompt: profileExtractorPrompt(batch, consent.mode),
        cacheScope: options.cacheScope ?? "profile-extractor",
        butlerData,
        signal: options.signal,
      }));
      addProfileModelUsage(modelUsage, { model, usage: raw.usage });
      const candidates = parseProfileExtractorResponse(
        raw.text,
        new Set(batch.map((item) => item.evidence_ref)),
        consent.mode,
      );
      for (const candidate of candidates) {
        const refs = candidate.evidence_refs.length > 0 ? candidate.evidence_refs : [null];
        for (const evidenceRef of refs) {
          const record = upsertProfileCandidate(butlerData, {
            layer: candidate.layer,
            category: candidate.category,
            facet: candidate.facet,
            summary: candidate.summary,
            applies_when: candidate.applies_when,
            butler_should: candidate.butler_should,
            butler_should_not: candidate.butler_should_not,
            temporal_scope: candidate.temporal_scope,
            decay_policy: candidate.decay_policy,
            contradiction_refs: candidate.contradiction_refs,
            sensitivity: candidate.sensitivity,
            source_type: candidate.source_type,
            confidence: candidate.confidence,
            evidence_ref: evidenceRef,
            sensitive_domain: candidate.sensitive_domain,
            expires_or_decay: candidate.expires_or_decay,
          });
          if (record) capturedCandidateIds.add(record.id);
        }
      }
    }
    return {
      profiling_enabled: true,
      mode: consent.mode,
      scanned_file_count: transcriptRead.scanned_file_count,
      scanned_event_count: transcriptRead.scanned_event_count,
      semantic_scanned_session_count: transcriptRead.semantic_scanned_session_count,
      semantic_scanned_message_count: transcriptRead.semantic_scanned_message_count,
      audit_transcript_scanned_file_count: transcriptRead.audit_transcript_scanned_file_count,
      audit_transcript_scanned_event_count: transcriptRead.audit_transcript_scanned_event_count,
      captured_candidate_count: capturedCandidateIds.size,
      raw_text_included: false,
      extractor_model: { ...extractorModel, effective_model: model },
      model_called: true,
      fallback_used: false,
      model_usage: modelUsage,
    };
  } catch (error) {
    return {
      profiling_enabled: true,
      mode: consent.mode,
      scanned_file_count: transcriptRead.scanned_file_count,
      scanned_event_count: transcriptRead.scanned_event_count,
      semantic_scanned_session_count: transcriptRead.semantic_scanned_session_count,
      semantic_scanned_message_count: transcriptRead.semantic_scanned_message_count,
      audit_transcript_scanned_file_count: transcriptRead.audit_transcript_scanned_file_count,
      audit_transcript_scanned_event_count: transcriptRead.audit_transcript_scanned_event_count,
      captured_candidate_count: 0,
      raw_text_included: false,
      extractor_model: { ...extractorModel, effective_model: model },
      model_called: true,
      fallback_used: false,
      model_usage: emptyProfileModelUsage(),
      model_error: error instanceof Error ? error.message : String(error),
    };
  }
}

function safeFileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

interface TranscriptTextObservation {
  text: string;
  evidence_ref: string;
  timestamp: string;
  now?: Date;
}

interface TranscriptTextObservationRead {
  scanned_file_count: number;
  scanned_event_count: number;
  semantic_scanned_session_count: number;
  semantic_scanned_message_count: number;
  audit_transcript_scanned_file_count: number;
  audit_transcript_scanned_event_count: number;
  observations: TranscriptTextObservation[];
}

interface ExtractedProfileCandidate {
  layer: ProfileLayer | null;
  category: ProfileCandidateCategory;
  facet: ProfileFacet | null;
  summary: string;
  applies_when: string[];
  butler_should: string[];
  butler_should_not: string[];
  temporal_scope: ProfileTemporalScope | null;
  decay_policy: ProfileDecayPolicy | null;
  contradiction_refs: string[];
  sensitivity: ProfileSensitivity | null;
  source_type: ProfileSourceType;
  confidence: ProfileConfidence;
  evidence_refs: string[];
  sensitive_domain: boolean;
  expires_or_decay: "expires" | "decay" | null;
}

function readProfileConversationObservations(
  butlerData: string,
  consent: ProfilingConsentSnapshot,
  options: ProfileTranscriptCaptureOptions,
): TranscriptTextObservationRead {
  const maxUserMessages = Math.max(
    1,
    Math.min(options.maxUserMessages ?? DEFAULT_PROFILE_TRANSCRIPT_MAX_USER_MESSAGES, MAX_PROFILE_TRANSCRIPT_USER_MESSAGES),
  );
  const sinceMs = profileTranscriptSinceMs(options.since, consent.consented_at);
  const since = Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : null;
  const observations = readConversationObservations({
    butlerData,
    roles: ["user"],
    since,
    includeCompacted: true,
    maxMessages: maxUserMessages,
    order: "desc",
  });
  const sessions = new Set(observations.map((observation) => observation.conversation_session_id));
  return {
    scanned_file_count: sessions.size,
    scanned_event_count: observations.length,
    semantic_scanned_session_count: sessions.size,
    semantic_scanned_message_count: observations.length,
    audit_transcript_scanned_file_count: 0,
    audit_transcript_scanned_event_count: 0,
    observations: observations.map((observation) => ({
      text: observation.text,
      evidence_ref: `conversation:${observation.conversation_message_id}`,
      timestamp: observation.created_at,
      now: new Date(observation.created_at),
    })),
  };
}

function _readTranscriptTextObservations(
  butlerData: string,
  consent: ProfilingConsentSnapshot,
  options: ProfileTranscriptCaptureOptions,
): TranscriptTextObservationRead {
  const transcriptDir = join(butlerData, "transcripts");
  if (!existsSync(transcriptDir)) {
    return {
      scanned_file_count: 0,
      scanned_event_count: 0,
      semantic_scanned_session_count: 0,
      semantic_scanned_message_count: 0,
      audit_transcript_scanned_file_count: 0,
      audit_transcript_scanned_event_count: 0,
      observations: [],
    };
  }

  const maxFiles = Math.max(
    1,
    Math.min(options.maxFiles ?? DEFAULT_PROFILE_TRANSCRIPT_MAX_FILES, MAX_PROFILE_TRANSCRIPT_FILES),
  );
  const maxUserMessages = Math.max(
    1,
    Math.min(options.maxUserMessages ?? DEFAULT_PROFILE_TRANSCRIPT_MAX_USER_MESSAGES, MAX_PROFILE_TRANSCRIPT_USER_MESSAGES),
  );
  const sinceMs = profileTranscriptSinceMs(options.since, consent.consented_at);
  const files = readdirSync(transcriptDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => {
      const path = join(transcriptDir, entry.name);
      const mtimeMs = safeFileMtimeMs(path);
      return { path, mtimeMs };
    })
    .filter((entry) => entry.mtimeMs >= sinceMs)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, maxFiles);

  let scannedEvents = 0;
  const observations: TranscriptTextObservation[] = [];

  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(file.path, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const event = parseTranscriptEventLine(line);
      if (!event || event.kind !== "inbound") continue;
      const eventMs = Date.parse(event.timestamp);
      if (Number.isFinite(eventMs) && eventMs < sinceMs) continue;
      scannedEvents += 1;
      const text = transcriptMessageText(event.payload);
      if (!text) continue;
      observations.push({
        text,
        evidence_ref: `transcript:${event.sessionId}:${event.eventId}`,
        timestamp: event.timestamp,
        now: Number.isFinite(eventMs) ? new Date(eventMs) : undefined,
      });
    }
  }

  return {
    scanned_file_count: files.length,
    scanned_event_count: scannedEvents,
    semantic_scanned_session_count: 0,
    semantic_scanned_message_count: 0,
    audit_transcript_scanned_file_count: files.length,
    audit_transcript_scanned_event_count: scannedEvents,
    observations: observations
      .sort((left, right) => timestampSortValue(right.timestamp) - timestampSortValue(left.timestamp))
      .slice(0, maxUserMessages),
  };
}

async function defaultProfileExtractorModelRunner(
  input: ProfileExtractorModelRunnerInput,
): Promise<string | ProfileExtractorModelRunnerResult> {
  if (!configuredProfileExtractorModelRunner) {
    throw new Error("Profile extractor model runner is not configured");
  }
  return await configuredProfileExtractorModelRunner(input);
}

function profileExtractionObservationBatches(
  observations: TranscriptTextObservation[],
  maxBatches: number,
): TranscriptTextObservation[][] {
  const batches: TranscriptTextObservation[][] = [];
  for (let index = 0; index < observations.length && batches.length < maxBatches; index += MAX_MODEL_OBSERVATIONS) {
    batches.push(observations.slice(index, index + MAX_MODEL_OBSERVATIONS));
  }
  return batches;
}

function profileExtractorInstructions(mode: Exclude<ProfilingMode, "off">): string {
  const categories: ProfileCandidateCategory[] = [
    "identity",
    "cares",
    "values",
    "narrative",
    "agency",
    "epistemic_style",
    "communication",
    "affective_landscape",
    "relationships",
    "aesthetics",
    "boundaries",
  ];
  const allowed = mode === "basic"
    ? ["communication", "epistemic_style", "boundaries"]
    : categories;
  const facets = mode === "basic"
    ? [
      "tone_preference",
      "explanation_preference",
      "evidence_preference",
      "correction_style",
      "privacy_rules",
      "consent_required",
    ]
    : [
      "identity.self_descriptions",
      "identity.roles",
      "identity.commitments",
      "cares.current_interests",
      "cares.enduring_interests",
      "cares.meaningful_objects",
      "values.explicit_values",
      "values.inferred_values",
      "values.disliked_values",
      "narrative.meaningful_events",
      "narrative.turning_points",
      "narrative.unresolved_threads",
      "agency.goals",
      "agency.active_projects",
      "agency.tensions",
      "agency.avoidance_patterns",
      "epistemic_style.how_the_user_thinks",
      "epistemic_style.evidence_preference",
      "epistemic_style.uncertainty_tolerance",
      "epistemic_style.correction_style",
      "communication.tone_preference",
      "communication.explanation_preference",
      "communication.emotional_mode",
      "affective_landscape.energizers",
      "affective_landscape.frustrations",
      "affective_landscape.comfort_patterns",
      "relationships.important_people_or_groups",
      "relationships.collaboration_preferences",
      "relationships.social_boundaries",
      "aesthetics.taste",
      "aesthetics.anti_taste",
      "aesthetics.quality_sense",
      "boundaries.privacy_rules",
      "boundaries.consent_required",
      "boundaries.sensitive_domains",
    ];
  return [
    "You are Butler's consent-gated user profile extractor.",
    "Extract durable profile candidates from user-authored canonical conversation observations using a philosophical user-profile template.",
    "Do not summarize the conversation. Do not include raw user text in the output.",
    "Only return candidates that can improve future personalization for the user.",
    `Allowed categories: ${allowed.join(", ")}.`,
    `Relevant profile facets to consider: ${facets.join(", ")}.`,
    "For deep mode, explicitly look for current_interests, meaningful_events, values, narrative threads, active projects, and agency signals before general style signals.",
    "Use facet without the category prefix, for example current_interests, meaningful_events, correction_style, quality_sense, privacy_rules.",
    "Use source_type explicit only when the user directly states a preference, value, boundary, name, goal, or self-description.",
    "Use source_type repeated_observation for repeated behavior across observations.",
    "Use source_type inference only for cautious, low-confidence interpretation.",
    "For basic mode, do not output sensitive personal content; generalize it into non-sensitive communication, epistemic, or boundary preferences when possible.",
    "Mark sensitive_domain true only when the candidate contains personal sensitive material such as health, private family or romantic relationships, personal finance, religion, political belief, legal identity, exact location, credentials, secrets, or similarly sensitive content.",
    "Do not mark ordinary language, public or broad career roles, collaboration preferences, communication style, technical interests, design taste, project context, or safety/privacy rules as sensitive merely because the category is identity, relationships, boundaries, or values.",
    "Also classify each candidate by layer: stable_disposition, contextual_adaptation, current_attention, or narrative_meaning.",
    "stable_disposition is for durable tendencies and values; contextual_adaptation is for situation-specific collaboration rules; current_attention is for active interests/projects; narrative_meaning is for meaningful events, identity stories, and unresolved threads.",
    "Include applies_when, butler_should, and butler_should_not when they help Butler act differently. Keep them short and behavior-level.",
    "Set temporal_scope to transient, active, or durable. Set decay_policy to days_7, days_30, reinforce_or_decay, or never_without_consent.",
    "Set sensitivity to normal, sensitive, or restricted.",
    "Return strict JSON only, with this shape:",
    '{"candidates":[{"layer":"current_attention","category":"cares","facet":"current_interests","summary":"short durable candidate, no raw quote","applies_when":["casual_chat"],"butler_should":["adapt examples to this interest when relevant"],"butler_should_not":["overfit unrelated answers to this topic"],"temporal_scope":"active","decay_policy":"days_30","source_type":"explicit","confidence":"medium","evidence_refs":["conversation:cm_..."],"sensitive_domain":false,"sensitivity":"normal","expires_or_decay":"decay"}]}',
  ].join("\n");
}

function profileExtractorPrompt(
  observations: TranscriptTextObservation[],
  mode: Exclude<ProfilingMode, "off">,
): string {
  const lines = [
    `Profiling mode: ${mode}`,
    "Analyze the observations below and return profile candidates as JSON.",
    "Evidence refs must come from the provided ref values.",
    "",
    "Observations:",
  ];
  let totalChars = lines.join("\n").length;
  for (const [index, observation] of observations.slice(0, MAX_MODEL_OBSERVATIONS).entries()) {
    const text = observation.text.replace(/\s+/gu, " ").trim().slice(0, MAX_MODEL_OBSERVATION_CHARS);
    const block = [
      `${index + 1}. ref=${observation.evidence_ref} at=${observation.timestamp}`,
      `text=${JSON.stringify(text)}`,
    ];
    const blockText = block.join("\n");
    if (totalChars + blockText.length > MAX_PROFILE_EXTRACTION_PROMPT_CHARS) break;
    lines.push(blockText);
    totalChars += blockText.length;
  }
  return lines.join("\n");
}

function profileThirdPartyImportExtractorPrompt(input: {
  source: string;
  importId: string;
  text: string;
  mode: Exclude<ProfilingMode, "off">;
  importedAt: string;
}): string {
  const text = input.text.replace(/\s+/gu, " ").trim().slice(0, MAX_PROFILE_IMPORT_PROMPT_TEXT_CHARS);
  return [
    `Profiling mode: ${input.mode}`,
    `Import source: ${input.source}`,
    `Import ref: ${input.importId}`,
    `Imported at: ${input.importedAt}`,
    "",
    "Analyze this third-party assistant export and return profile candidates as JSON.",
    "Every evidence_refs item must be exactly the Import ref above.",
    "Do not preserve or quote raw import text.",
    "",
    "Imported export:",
    JSON.stringify(text),
  ].join("\n");
}

function normalizeProfileImportText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n/gu, "\n").trim().slice(0, MAX_PROFILE_IMPORT_TEXT_CHARS);
}

function normalizeProfileImportSource(value: string | null | undefined): string {
  const normalized = typeof value === "string"
    ? value.trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "")
    : "";
  return normalized || "external-ai";
}

function profileImportHash(source: string, text: string): string {
  return createHash("sha256").update(`${source}\n${text}`).digest("hex").slice(0, 16);
}

function writeProfileImportManifest(
  butlerData: string,
  manifest: {
    import_id: string;
    source: string;
    imported_at: string;
    text_sha256: string;
    input_chars: number;
    candidate_ids: string[];
    raw_text_included: false;
  },
): void {
  const dir = join(butlerData, "personalization", "profile-imports");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${manifest.text_sha256}.json`);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function parseProfileExtractorResponse(
  raw: string,
  allowedEvidenceRefs: Set<string>,
  mode: Exclude<ProfilingMode, "off">,
): ExtractedProfileCandidate[] {
  const payload = parseJsonObjectFromText(raw);
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const parsed: ExtractedProfileCandidate[] = [];
  for (const item of candidates) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rawItem = item as Record<string, unknown>;
    const category = typeof rawItem.category === "string"
      ? normalizeCategory(rawItem.category)
      : null;
    if (!category || !categoryAllowedInMode(category, mode)) continue;
    const summary = typeof rawItem.summary === "string"
      ? normalizeSummary(rawItem.summary)
      : "";
    if (!summary) continue;
    const evidenceRefs = Array.isArray(rawItem.evidence_refs)
      ? uniqueStrings(rawItem.evidence_refs
        .filter((ref): ref is string => typeof ref === "string")
        .map((ref) => ref.trim())
        .filter((ref) => allowedEvidenceRefs.has(ref)))
        .slice(0, 12)
      : [];
    const facet = typeof rawItem.facet === "string"
      ? normalizeProfileFacet(rawItem.facet)
      : null;
    const sensitiveDomain = normalizeProfileSensitiveDomain({
      category,
      facet,
      summary,
      declaredSensitive: rawItem.sensitive_domain === true,
    });
    parsed.push({
      layer: typeof rawItem.layer === "string"
        ? normalizeProfileLayer(rawItem.layer)
        : null,
      category,
      facet,
      summary,
      applies_when: normalizeShortStringList(rawItem.applies_when),
      butler_should: normalizeShortStringList(rawItem.butler_should),
      butler_should_not: normalizeShortStringList(rawItem.butler_should_not),
      temporal_scope: typeof rawItem.temporal_scope === "string"
        ? normalizeTemporalScope(rawItem.temporal_scope)
        : null,
      decay_policy: typeof rawItem.decay_policy === "string"
        ? normalizeDecayPolicy(rawItem.decay_policy)
        : null,
      contradiction_refs: normalizeShortStringList(rawItem.contradiction_refs),
      sensitivity: typeof rawItem.sensitivity === "string"
        ? normalizeProfileSensitivity(rawItem.sensitivity)
        : null,
      source_type: typeof rawItem.source_type === "string"
        ? normalizeSourceType(rawItem.source_type)
        : "inference",
      confidence: typeof rawItem.confidence === "string"
        ? normalizeConfidence(rawItem.confidence)
        : "low",
      evidence_refs: evidenceRefs,
      sensitive_domain: sensitiveDomain,
      expires_or_decay: rawItem.expires_or_decay === "expires" || rawItem.expires_or_decay === "decay"
        ? rawItem.expires_or_decay
        : "decay",
    });
  }
  return parsed.slice(0, 40);
}

function parseJsonObjectFromText(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?/iu, "").replace(/```$/u, "").trim();
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) return {};
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
}

export function consolidateProfileCandidates(
  butlerData: string,
): ProfileConsolidationResult {
  const consent = readProfilingConsentSnapshot(butlerData);
  if (consent.mode === "off") {
    if (existsSync(profileBlackBoxPath(butlerData))) {
      const db = openProfileDb(butlerData, true);
      try {
        deleteRuntimeProfileProjectionInDb(db);
      } finally {
        db.close();
      }
    }
    return {
      profiling_enabled: false,
      mode: "off",
      candidate_count: 0,
      promoted_count: 0,
      skipped_count: 0,
      rejected_count: 0,
      stable_entry_count: 0,
      projection_written: false,
      raw_text_included: false,
    };
  }

  const db = openProfileDb(butlerData, true);
  let candidateCount: number;
  let promotedCount = 0;
  let skippedCount = 0;
  let rejectedCount: number;
  try {
    const candidates = (db.query(`
      SELECT *
      FROM profile_candidates
      WHERE status = 'candidate'
      ORDER BY updated_at ASC
    `).all() as ProfileCandidateRow[])
      .map(recordFromCandidateRow)
      .filter(Boolean) as ProfileCandidateRecord[];
    candidateCount = candidates.length;
    for (const rawCandidate of candidates) {
      const candidate = normalizeProfileCandidateSensitivity(rawCandidate);
      if (
        candidate.sensitive_domain !== rawCandidate.sensitive_domain ||
        candidate.sensitivity !== rawCandidate.sensitivity
      ) {
        writeProfileCandidateInDb(db, candidate);
      }
      if (!categoryAllowedInMode(candidate.category, consent.mode)) {
        skippedCount += 1;
        continue;
      }
      if (candidateFilteredByProfilingMode(candidate, consent.mode)) {
        skippedCount += 1;
        continue;
      }
      if (!candidateReadyForPromotion(candidate)) {
        skippedCount += 1;
        continue;
      }
      writeStableEntryInDb(db, stableEntryFromCandidate(candidate));
      writeProfileCandidateInDb(db, {
        ...candidate,
        status: "promoted",
        promoted_at: iso(),
        updated_at: iso(),
      });
      promotedCount += 1;
    }
    rejectedCount = expireOldLowConfidenceCandidates(db);
    const stableEntries = listStableProfileEntriesFromDb(db);
    const projection = buildRuntimeProjection(stableEntries, consent.mode);
    const projectionWritten = projection.response_hints.length > 0 ||
      projection.current_attention.length > 0 ||
      projection.caution_hints.length > 0;
    if (projectionWritten) writeRuntimeProfileProjectionInDb(db, projection);
    else deleteRuntimeProfileProjectionInDb(db);
    return {
      profiling_enabled: true,
      mode: consent.mode,
      candidate_count: candidateCount,
      promoted_count: promotedCount,
      skipped_count: skippedCount,
      rejected_count: rejectedCount,
      stable_entry_count: stableEntries.length,
      projection_written: projectionWritten,
      raw_text_included: false,
    };
  } finally {
    db.close();
  }
}

export function writeRuntimeProfileProjection(
  butlerData: string,
  projection: RuntimeProfileProjection,
): RuntimeProfileProjection {
  const normalized = normalizeRuntimeProfileProjection(projection);
  const db = openProfileDb(butlerData, true);
  try {
    writeRuntimeProfileProjectionInDb(db, normalized);
  } finally {
    db.close();
  }
  return normalized;
}

export function readRuntimeProfileProjection(
  butlerData: string,
): RuntimeProfileProjection | null {
  const path = profileBlackBoxPath(butlerData);
  if (!existsSync(path)) return null;
  const db = openProfileDb(butlerData, false);
  try {
    const row = db.query(`
      SELECT payload_json
      FROM runtime_projection
      WHERE id = 'active'
      LIMIT 1
    `).get() as { payload_json?: string } | null;
    if (!row?.payload_json) return null;
    return normalizeRuntimeProfileProjection(JSON.parse(row.payload_json));
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export function renderRuntimeProfileProjectionPrompt(
  projection: RuntimeProfileProjection | null,
): string | null {
  if (!projection) return null;
  const groups = [
    ["How to answer", projection.how_to_answer],
    ["How to collaborate", projection.how_to_collaborate],
    ["Current attention", projection.current_attention],
    ["Active boundaries", projection.active_boundaries],
    ["Likely failure modes", projection.likely_failure_modes],
    ["Ask before", projection.ask_before],
  ] as const;
  const lines = [
    "# Runtime Profile Projection",
    "",
    `- Mode: ${projection.mode}`,
    `- Version: ${projection.version}`,
    "",
    "Use these as lightweight adaptation hints. Do not treat them as a raw biography or expose them as profile data.",
  ];
  for (const [title, hints] of groups) {
    if (hints.length === 0) continue;
    lines.push("", `## ${title}`);
    for (const hint of hints.slice(0, MAX_HINTS_PER_GROUP)) {
      lines.push(`- ${hint}`);
    }
  }
  return lines.join("\n");
}

export function readReflectiveProfileSummary(
  butlerData: string,
  locale: "en" | "ko" = "ko",
): ReflectiveProfileSummary {
  const consent = readProfilingConsentSnapshot(butlerData);
  if (consent.mode === "off") {
    return {
      ok: true,
      profiling_enabled: false,
      mode: "off",
      entry_count: 0,
      summary: locale === "ko"
        ? "프로파일링이 꺼져 있어, 사용자를 장기 프로필로 해석하지 않습니다."
        : "Profiling is off, so Butler is not maintaining a long-term user profile.",
      bullets: [],
      raw_profile_included: false,
    };
  }
  const entries = listStableProfileEntries(butlerData);
  if (entries.length === 0) {
    return {
      ok: true,
      profiling_enabled: true,
      mode: consent.mode,
      entry_count: 0,
      summary: locale === "ko"
        ? "아직 확정적으로 정리된 프로필 항목은 없습니다. Butler는 먼저 후보로 관찰하고, 명시성이나 반복성이 충분할 때만 반영합니다."
        : "No stable profile entries have been consolidated yet. Butler keeps observations as candidates first and only promotes them when evidence is sufficient.",
      bullets: [],
      raw_profile_included: false,
    };
  }
  const bullets = stableEntriesToReflectiveBullets(entries, locale);
  return {
    ok: true,
    profiling_enabled: true,
    mode: consent.mode,
    entry_count: entries.length,
    summary: locale === "ko"
      ? "지금까지의 명시 피드백과 반복 관찰을 바탕으로 Butler가 조심스럽게 형성한 이해입니다. 단정이 아니라 현재까지의 작업 가설입니다."
      : "This is Butler's careful current understanding from explicit feedback and repeated observations. It is a working interpretation, not a fixed judgment.",
    bullets,
    raw_profile_included: false,
  };
}

function openProfileDb(butlerData: string, create: boolean): Database {
  const path = profileBlackBoxPath(butlerData);
  if (create) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, create ? { create: true } : { readonly: true });
  if (create) db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  if (create) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_meta (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_candidates (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        source_type TEXT NOT NULL,
        confidence TEXT NOT NULL,
        sensitive_domain INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_or_decay TEXT
      );
      CREATE TABLE IF NOT EXISTS stable_profile_entries (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        confidence TEXT NOT NULL,
        source_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_projection (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        mode TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    ensureProfileCandidateColumns(db);
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best-effort on filesystems that do not support POSIX modes.
    }
  }
  return db;
}

function ensureProfileCandidateColumns(db: Database): void {
  ensureColumn(db, "profile_candidates", "status", "status TEXT NOT NULL DEFAULT 'candidate'");
  ensureColumn(db, "profile_candidates", "promoted_at", "promoted_at TEXT");
}

function ensureColumn(
  db: Database,
  table: string,
  column: string,
  definition: string,
): void {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function defaultProfilingConsentSnapshot(): ProfilingConsentSnapshot {
  return {
    mode: "off",
    consent_version: PROFILE_CONSENT_VERSION,
    consented_at: null,
    raw_profile_browser_visible: false,
  };
}

type JsonRecord = Record<string, any>;

function butlerConfigPath(butlerData: string): string {
  return join(butlerData, "butler.config.json");
}

function readButlerConfigJson(butlerData: string): JsonRecord {
  const path = butlerConfigPath(butlerData);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return normalizeJsonObject(parsed);
  } catch {
    return {};
  }
}

function writeButlerConfigJsonAtomic(butlerData: string, config: JsonRecord): void {
  const path = butlerConfigPath(butlerData);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function normalizeJsonObject(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function normalizeProfilingExtractorModelRef(value: unknown): string | null {
  if (typeof value !== "string") return PROFILE_EXTRACTOR_MODEL_DEFAULT;
  const trimmed = value.trim();
  if (!trimmed || trimmed === PROFILE_EXTRACTOR_MODEL_DEFAULT || trimmed === "butler") {
    return PROFILE_EXTRACTOR_MODEL_DEFAULT;
  }
  const parsed = parseModelRef(trimmed);
  return parsed.modelId ? parsed.canonicalRef : PROFILE_EXTRACTOR_MODEL_DEFAULT;
}

function normalizeProfilingExtractorReasoningEffort(
  value: unknown,
): ReasoningEffort | null {
  if (
    value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  ) {
    return value;
  }
  return null;
}

function normalizeButlerModelRef(config: JsonRecord): string | null {
  const raw = config.system?.butlerModel ?? config.system?.defaultModel;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parsed = parseModelRef(raw);
  return parsed.modelId ? parsed.canonicalRef : null;
}

function readAppSettingsModelRef(butlerData: string): string | null {
  const path = join(butlerData, "app-server", "butler-client.sqlite");
  if (!existsSync(path)) return null;
  let db: Database;
  try {
    db = new Database(path, { readonly: true });
  } catch {
    return null;
  }
  try {
    const row = db.query(`
      SELECT value_json
      FROM app_settings
      WHERE key = 'settings'
      LIMIT 1
    `).get() as { value_json?: string } | null;
    if (!row?.value_json) return null;
    const parsed = JSON.parse(row.value_json) as { model?: unknown };
    if (typeof parsed.model !== "string" || !parsed.model.trim()) return null;
    const model = parseModelRef(parsed.model);
    return model.modelId ? model.canonicalRef : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function readAppSettingsReasoningEffort(
  butlerData: string,
): ReasoningEffort | null {
  const path = join(butlerData, "app-server", "butler-client.sqlite");
  if (!existsSync(path)) return null;
  let db: Database;
  try {
    db = new Database(path, { readonly: true });
  } catch {
    return null;
  }
  try {
    const row = db.query(`
      SELECT value_json
      FROM app_settings
      WHERE key = 'settings'
      LIMIT 1
    `).get() as { value_json?: string } | null;
    if (!row?.value_json) return null;
    const parsed = JSON.parse(row.value_json) as {
      reasoning_effort?: unknown;
    };
    return normalizeProfilingExtractorReasoningEffort(
      parsed.reasoning_effort,
    );
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function normalizeRuntimeProfileProjection(value: unknown): RuntimeProfileProjection {
  const raw = value && typeof value === "object"
    ? value as Partial<RuntimeProfileProjection>
    : {};
  const mode = raw.mode === "basic" || raw.mode === "deep" ? raw.mode : "basic";
  const howToAnswer = normalizeHints(raw.how_to_answer ?? raw.response_hints);
  const howToCollaborate = normalizeHints(raw.how_to_collaborate);
  const currentAttention = normalizeHints(raw.current_attention);
  const activeBoundaries = normalizeHints(raw.active_boundaries);
  const likelyFailureModes = normalizeHints(raw.likely_failure_modes);
  const askBefore = normalizeHints(raw.ask_before);
  const cautionHints = normalizeHints(
    raw.caution_hints ?? [...activeBoundaries, ...likelyFailureModes, ...askBefore],
  );
  return {
    version: normalizeVersion(raw.version),
    mode,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : new Date(0).toISOString(),
    how_to_answer: howToAnswer,
    how_to_collaborate: howToCollaborate,
    response_hints: howToAnswer,
    current_attention: currentAttention,
    active_boundaries: activeBoundaries,
    likely_failure_modes: likelyFailureModes,
    ask_before: askBefore,
    caution_hints: cautionHints,
  };
}

function normalizeVersion(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function normalizeHints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .map((item) => item.length > MAX_HINT_CHARS ? item.slice(0, MAX_HINT_CHARS) : item)
    .slice(0, MAX_HINTS_PER_GROUP);
}

function normalizeShortStringList(value: unknown, limit = 6): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .map((item) => item.length > MAX_HINT_CHARS ? item.slice(0, MAX_HINT_CHARS) : item))
    .slice(0, limit);
}

function normalizeSummary(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, MAX_SUMMARY_CHARS);
}

function normalizeEvidenceRef(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, 160);
}

function categoryAllowedInMode(
  category: ProfileCandidateCategory,
  mode: ProfilingMode,
): boolean {
  if (mode === "off") return false;
  if (mode === "deep") return true;
  return BASIC_PROFILE_CATEGORIES.has(category);
}

function profileCandidateId(category: ProfileCandidateCategory, facet: ProfileFacet | null, summary: string): string {
  const hash = createHash("sha256").update(`${category}\0${facet ?? ""}\0${summary}`).digest("hex").slice(0, 16);
  return `pc_${hash}`;
}

function stableProfileEntryId(category: ProfileCandidateCategory, facet: ProfileFacet | null, summary: string): string {
  const hash = createHash("sha256").update(`${category}\0${facet ?? ""}\0${summary}`).digest("hex").slice(0, 16);
  return `sp_${hash}`;
}

type ProfileUnderstandingFields = Pick<
  ProfileCandidateRecord,
  | "layer"
  | "applies_when"
  | "butler_should"
  | "butler_should_not"
  | "temporal_scope"
  | "decay_policy"
  | "contradiction_refs"
  | "sensitivity"
>;

function mergeProfileUnderstandingFields(
  existing: ProfileCandidateRecord | null,
  input: ProfileCandidateInput,
): ProfileUnderstandingFields {
  const defaults = defaultProfileUnderstandingFields(
    input.category,
    normalizeProfileFacet(input.facet),
    input.summary,
    Boolean(input.sensitive_domain),
  );
  return {
    layer: normalizeProfileLayer(input.layer) ?? existing?.layer ?? defaults.layer,
    applies_when: uniqueStrings([
      ...normalizeShortStringList(existing?.applies_when),
      ...normalizeShortStringList(input.applies_when),
      ...defaults.applies_when,
    ]).slice(0, 6),
    butler_should: uniqueStrings([
      ...normalizeShortStringList(existing?.butler_should),
      ...normalizeShortStringList(input.butler_should),
      ...defaults.butler_should,
    ]).slice(0, 6),
    butler_should_not: uniqueStrings([
      ...normalizeShortStringList(existing?.butler_should_not),
      ...normalizeShortStringList(input.butler_should_not),
      ...defaults.butler_should_not,
    ]).slice(0, 6),
    temporal_scope: normalizeTemporalScope(input.temporal_scope) ?? existing?.temporal_scope ?? defaults.temporal_scope,
    decay_policy: normalizeDecayPolicy(input.decay_policy) ?? existing?.decay_policy ?? defaults.decay_policy,
    contradiction_refs: uniqueStrings([
      ...normalizeShortStringList(existing?.contradiction_refs),
      ...normalizeShortStringList(input.contradiction_refs),
    ]).slice(0, 6),
    sensitivity: normalizeProfileSensitivity(input.sensitivity) ?? existing?.sensitivity ?? defaults.sensitivity,
  };
}

function defaultProfileUnderstandingFields(
  category: ProfileCandidateCategory,
  facet: ProfileFacet | null,
  summary: string,
  sensitive: boolean,
): ProfileUnderstandingFields {
  const layer = inferProfileLayer(category, facet);
  const temporal_scope = layer === "current_attention"
    ? "active"
    : layer === "stable_disposition" || layer === "narrative_meaning"
      ? "durable"
      : "active";
  const decay_policy = layer === "current_attention"
    ? "days_30"
    : sensitive
      ? "never_without_consent"
      : "reinforce_or_decay";
  return {
    layer,
    applies_when: inferAppliesWhen(category, facet),
    butler_should: inferButlerShould(category, facet, summary),
    butler_should_not: inferButlerShouldNot(category, facet),
    temporal_scope,
    decay_policy,
    contradiction_refs: [],
    sensitivity: sensitive ? "sensitive" : "normal",
  };
}

function inferProfileLayer(category: ProfileCandidateCategory, facet: ProfileFacet | null): ProfileLayer {
  if (category === "cares" || facet === "current_interests" || facet === "active_projects") return "current_attention";
  if (
    category === "narrative" ||
    facet === "meaningful_events" ||
    facet === "turning_points" ||
    facet === "unresolved_threads" ||
    facet === "self_descriptions" ||
    facet === "commitments"
  ) {
    return "narrative_meaning";
  }
  if (
    category === "communication" ||
    category === "epistemic_style" ||
    category === "boundaries" ||
    facet === "collaboration_preferences" ||
    facet === "correction_style" ||
    facet === "evidence_preference"
  ) {
    return "contextual_adaptation";
  }
  return "stable_disposition";
}

function inferAppliesWhen(category: ProfileCandidateCategory, facet: ProfileFacet | null): string[] {
  if (category === "communication") return ["answering"];
  if (category === "epistemic_style") return ["analysis", "recommendation", "implementation_report"];
  if (category === "boundaries") return ["all_interactions"];
  if (facet === "current_interests") return ["topic_relevance"];
  if (facet === "active_projects") return ["project_work"];
  if (category === "aesthetics") return ["design_review", "product_recommendation"];
  return [];
}

function inferButlerShould(
  category: ProfileCandidateCategory,
  facet: ProfileFacet | null,
  summary: string,
): string[] {
  if (category === "communication") return [summary];
  if (category === "epistemic_style") return [summary];
  if (category === "boundaries") return ["respect this boundary before optimizing for convenience"];
  if (facet === "current_interests") return ["use this as current context only when relevant"];
  if (facet === "active_projects") return ["prioritize this context in related project work"];
  if (category === "aesthetics") return ["reflect this quality bar in visual or product judgments"];
  return [];
}

function inferButlerShouldNot(category: ProfileCandidateCategory, facet: ProfileFacet | null): string[] {
  if (category === "boundaries") return ["expose private internals without explicit request"];
  if (category === "epistemic_style") return ["claim completion without verification"];
  if (facet === "current_interests") return ["overfit unrelated answers to this interest"];
  return [];
}

function strongerSourceType(
  left: ProfileSourceType | undefined,
  right: ProfileSourceType,
): ProfileSourceType {
  const rank: Record<ProfileSourceType, number> = {
    inference: 0,
    repeated_observation: 1,
    explicit: 2,
    user_confirmed: 3,
  };
  if (!left) return right;
  return rank[right] > rank[left] ? right : left;
}

function strongerConfidence(
  left: ProfileConfidence | undefined,
  right: ProfileConfidence,
): ProfileConfidence {
  const rank: Record<ProfileConfidence, number> = {
    low: 0,
    medium: 1,
    high: 2,
  };
  if (!left) return right;
  return rank[right] > rank[left] ? right : left;
}

function writeProfileCandidateInDb(db: Database, record: ProfileCandidateRecord): void {
  db.prepare(`
    INSERT INTO profile_candidates (
      id, category, payload_json, source_type, confidence, sensitive_domain,
      created_at, updated_at, last_seen_at, expires_or_decay, status, promoted_at
    )
    VALUES (
      $id, $category, $payload_json, $source_type, $confidence, $sensitive_domain,
      $created_at, $updated_at, $last_seen_at, $expires_or_decay, $status, $promoted_at
    )
    ON CONFLICT(id) DO UPDATE SET
      category = excluded.category,
      payload_json = excluded.payload_json,
      source_type = excluded.source_type,
      confidence = excluded.confidence,
      sensitive_domain = excluded.sensitive_domain,
      updated_at = excluded.updated_at,
      last_seen_at = excluded.last_seen_at,
      expires_or_decay = excluded.expires_or_decay,
      status = excluded.status,
      promoted_at = excluded.promoted_at
  `).run({
    $id: record.id,
    $category: record.category,
    $payload_json: JSON.stringify(candidatePayload(record)),
    $source_type: record.source_type,
    $confidence: record.confidence,
    $sensitive_domain: record.sensitive_domain ? 1 : 0,
    $created_at: record.created_at,
    $updated_at: record.updated_at,
    $last_seen_at: record.last_seen_at,
    $expires_or_decay: record.expires_or_decay,
    $status: record.status,
    $promoted_at: record.promoted_at,
  });
}

function readProfileCandidateFromDb(
  db: Database,
  id: string,
): ProfileCandidateRecord | null {
  const row = db.query(`
    SELECT *
    FROM profile_candidates
    WHERE id = $id
    LIMIT 1
  `).get({ $id: id }) as ProfileCandidateRow | null;
  return row ? recordFromCandidateRow(row) : null;
}

function writeStableEntryInDb(db: Database, entry: StableProfileEntry): void {
  const existing = readStableEntryFromDb(db, entry.id);
  const merged: StableProfileEntry = existing
    ? {
      ...entry,
      evidence_refs: uniqueStrings([...existing.evidence_refs, ...entry.evidence_refs]),
      evidence_count: Math.max(existing.evidence_count, entry.evidence_count),
      applies_when: uniqueStrings([...existing.applies_when, ...entry.applies_when]).slice(0, 6),
      butler_should: uniqueStrings([...existing.butler_should, ...entry.butler_should]).slice(0, 6),
      butler_should_not: uniqueStrings([...existing.butler_should_not, ...entry.butler_should_not]).slice(0, 6),
      contradiction_refs: uniqueStrings([...existing.contradiction_refs, ...entry.contradiction_refs]).slice(0, 6),
      sensitivity: existing.sensitivity === "restricted" || entry.sensitivity === "restricted"
        ? "restricted"
        : existing.sensitivity === "sensitive" || entry.sensitivity === "sensitive"
          ? "sensitive"
          : "normal",
      confidence: strongerConfidence(existing.confidence, entry.confidence),
      source_type: strongerSourceType(existing.source_type, entry.source_type),
      created_at: existing.created_at,
      updated_at: iso(),
    }
    : entry;
  db.prepare(`
    INSERT INTO stable_profile_entries (
      id, category, payload_json, confidence, source_type, created_at, updated_at
    )
    VALUES (
      $id, $category, $payload_json, $confidence, $source_type, $created_at, $updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      category = excluded.category,
      payload_json = excluded.payload_json,
      confidence = excluded.confidence,
      source_type = excluded.source_type,
      updated_at = excluded.updated_at
  `).run({
    $id: merged.id,
    $category: merged.category,
    $payload_json: JSON.stringify(stablePayload(merged)),
    $confidence: merged.confidence,
    $source_type: merged.source_type,
    $created_at: merged.created_at,
    $updated_at: merged.updated_at,
  });
}

function readStableEntryFromDb(db: Database, id: string): StableProfileEntry | null {
  const row = db.query(`
    SELECT *
    FROM stable_profile_entries
    WHERE id = $id
    LIMIT 1
  `).get({ $id: id }) as StableProfileRow | null;
  return row ? recordFromStableRow(row) : null;
}

function listStableProfileEntriesFromDb(db: Database): StableProfileEntry[] {
  const rows = db.query(`
    SELECT *
    FROM stable_profile_entries
    ORDER BY updated_at DESC, id ASC
  `).all() as StableProfileRow[];
  return rows.map(recordFromStableRow).filter(Boolean) as StableProfileEntry[];
}

function writeRuntimeProfileProjectionInDb(
  db: Database,
  projection: RuntimeProfileProjection,
): void {
  const normalized = normalizeRuntimeProfileProjection(projection);
  db.prepare(`
    INSERT INTO runtime_projection (id, version, mode, payload_json, updated_at)
    VALUES ('active', $version, $mode, $payload_json, $updated_at)
    ON CONFLICT(id) DO UPDATE SET
      version = excluded.version,
      mode = excluded.mode,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `).run({
    $version: normalized.version,
    $mode: normalized.mode,
    $payload_json: JSON.stringify(normalized),
    $updated_at: normalized.updated_at,
  });
}

function deleteRuntimeProfileProjectionInDb(db: Database): void {
  db.exec("DELETE FROM runtime_projection");
}

function stableEntryFromCandidate(candidate: ProfileCandidateRecord): StableProfileEntry {
  return {
    id: stableProfileEntryId(candidate.category, candidate.facet, candidate.summary),
    layer: candidate.layer,
    category: candidate.category,
    facet: candidate.facet,
    summary: candidate.summary,
    applies_when: candidate.applies_when,
    butler_should: candidate.butler_should,
    butler_should_not: candidate.butler_should_not,
    temporal_scope: candidate.temporal_scope,
    decay_policy: candidate.decay_policy,
    contradiction_refs: candidate.contradiction_refs,
    sensitivity: candidate.sensitivity,
    evidence_refs: candidate.evidence_refs,
    evidence_count: candidate.evidence_count,
    source_type: candidate.source_type,
    confidence: candidate.confidence,
    sensitive_domain: candidate.sensitive_domain,
    created_at: iso(),
    updated_at: iso(),
  };
}

function normalizeProfileCandidateSensitivity(
  candidate: ProfileCandidateRecord,
): ProfileCandidateRecord {
  const sensitiveDomain = normalizeProfileSensitiveDomain({
    category: candidate.category,
    facet: candidate.facet,
    summary: candidate.summary,
    declaredSensitive: candidate.sensitive_domain,
  });
  if (sensitiveDomain === candidate.sensitive_domain) return candidate;
  return {
    ...candidate,
    sensitive_domain: sensitiveDomain,
    sensitivity: sensitiveDomain ? candidate.sensitivity : "normal",
  };
}

function candidateFilteredByProfilingMode(
  candidate: ProfileCandidateRecord,
  mode: ProfilingMode,
): boolean {
  if (mode === "deep") return false;
  if (mode === "basic") return candidate.sensitive_domain;
  return true;
}

function candidateReadyForPromotion(candidate: ProfileCandidateRecord): boolean {
  if (candidate.source_type === "user_confirmed") return true;
  if (candidate.source_type === "explicit" && candidate.confidence === "high") return true;
  if (
    hasThirdPartyImportEvidence(candidate) &&
    candidate.confidence !== "low"
  ) {
    return true;
  }
  if (
    candidate.category === "cares" &&
    candidate.facet === "current_interests" &&
    candidate.source_type === "explicit" &&
    candidate.confidence !== "low" &&
    !candidate.sensitive_domain
  ) {
    return true;
  }
  if (candidate.evidence_count >= 2 && candidate.confidence !== "low") return true;
  return false;
}

function hasThirdPartyImportEvidence(candidate: ProfileCandidateRecord): boolean {
  return candidate.evidence_refs.some((ref) =>
    ref.startsWith("third_party_profile_import:"),
  );
}

function expireOldLowConfidenceCandidates(db: Database): number {
  const cutoff = Date.now() - (1000 * 60 * 60 * 24 * 90);
  const candidates = (db.query(`
    SELECT *
    FROM profile_candidates
    WHERE status = 'candidate'
      AND confidence = 'low'
      AND expires_or_decay = 'decay'
  `).all() as ProfileCandidateRow[])
    .map(recordFromCandidateRow)
    .filter(Boolean) as ProfileCandidateRecord[];
  let rejected = 0;
  for (const candidate of candidates) {
    if (Date.parse(candidate.updated_at) >= cutoff) continue;
    writeProfileCandidateInDb(db, {
      ...candidate,
      status: "expired",
      updated_at: iso(),
    });
    rejected += 1;
  }
  return rejected;
}

function buildRuntimeProjection(
  entries: StableProfileEntry[],
  mode: Exclude<ProfilingMode, "off">,
): RuntimeProfileProjection {
  const answer: string[] = [];
  const collaborate: string[] = [];
  const attention: string[] = [];
  const boundaries: string[] = [];
  const failureModes: string[] = [];
  const askBefore: string[] = [];
  for (const entry of entries) {
    if (entry.layer === "current_attention") {
      attention.push(entry.summary);
      continue;
    }
    if (entry.layer === "narrative_meaning") {
      collaborate.push(entry.summary);
      continue;
    }
    if (entry.category === "communication") {
      answer.push(...(entry.butler_should.length > 0 ? entry.butler_should : [entry.summary]));
      continue;
    }
    if (entry.category === "epistemic_style") {
      answer.push(...(entry.butler_should.length > 0 ? entry.butler_should : [entry.summary]));
      failureModes.push(...entry.butler_should_not);
      continue;
    }
    if (entry.category === "boundaries") {
      boundaries.push(entry.summary, ...entry.butler_should_not);
      if (entry.sensitivity !== "normal") askBefore.push(entry.summary);
      continue;
    }
    if (entry.layer === "contextual_adaptation") {
      collaborate.push(...(entry.butler_should.length > 0 ? entry.butler_should : [entry.summary]));
    } else {
      collaborate.push(entry.summary);
    }
    if (entry.category === "affective_landscape") failureModes.push(entry.summary);
  }
  const normalizedAnswer = normalizeHints(answer);
  const normalizedBoundaries = normalizeHints(boundaries);
  const normalizedFailures = normalizeHints(failureModes);
  const normalizedAskBefore = normalizeHints(askBefore);
  return {
    version: Date.now(),
    mode,
    updated_at: iso(),
    how_to_answer: normalizedAnswer,
    how_to_collaborate: normalizeHints(collaborate),
    response_hints: normalizedAnswer,
    current_attention: normalizeHints(attention),
    active_boundaries: normalizedBoundaries,
    likely_failure_modes: normalizedFailures,
    ask_before: normalizedAskBefore,
    caution_hints: normalizeHints([
      ...normalizedBoundaries,
      ...normalizedFailures,
      ...normalizedAskBefore,
    ]),
  };
}

function timestampSortValue(timestamp: string): number {
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : 0;
}

function profileTranscriptSinceMs(
  override: string | Date | null | undefined,
  _consentedAt: string | null,
): number {
  const source = override ?? null;
  if (!source) return 0;
  const ms = source instanceof Date ? source.getTime() : Date.parse(source);
  return Number.isFinite(ms) ? ms : 0;
}

interface ParsedTranscriptEvent {
  eventId: string;
  sessionId: string;
  kind: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

function parseTranscriptEventLine(line: string): ParsedTranscriptEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<ParsedTranscriptEvent>;
    if (
      typeof parsed.eventId === "string" &&
      typeof parsed.sessionId === "string" &&
      typeof parsed.kind === "string" &&
      typeof parsed.timestamp === "string" &&
      parsed.payload &&
      typeof parsed.payload === "object" &&
      !Array.isArray(parsed.payload)
    ) {
      return parsed as ParsedTranscriptEvent;
    }
  } catch {
    return null;
  }
  return null;
}

function transcriptMessageText(payload: Record<string, unknown>): string {
  const message = payload.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return "";
  const text = (message as { text?: unknown }).text;
  return typeof text === "string" ? text.trim() : "";
}

function normalizeProfileSensitiveDomain(input: {
  category: ProfileCandidateCategory;
  facet: ProfileFacet | null;
  summary: string;
  declaredSensitive: boolean;
}): boolean {
  if (input.facet === "privacy_rules" || input.facet === "consent_required") {
    return false;
  }
  if (!input.declaredSensitive) return false;
  if (isUsuallyNonSensitiveProfileFacet(input.category, input.facet)) return false;
  return true;
}

function isUsuallyNonSensitiveProfileFacet(
  category: ProfileCandidateCategory,
  facet: ProfileFacet | null,
): boolean {
  if (
    category === "communication" ||
    category === "epistemic_style" ||
    category === "aesthetics"
  ) {
    return true;
  }
  return facet === "roles" ||
    facet === "self_descriptions" ||
    facet === "current_interests" ||
    facet === "enduring_interests" ||
    facet === "meaningful_objects" ||
    facet === "active_projects" ||
    facet === "collaboration_preferences" ||
    facet === "quality_sense" ||
    facet === "tone_preference" ||
    facet === "explanation_preference" ||
    facet === "emotional_mode" ||
    facet === "how_the_user_thinks" ||
    facet === "evidence_preference" ||
    facet === "correction_style" ||
    facet === "privacy_rules" ||
    facet === "consent_required";
}

function stableEntriesToReflectiveBullets(
  entries: StableProfileEntry[],
  locale: "en" | "ko",
): string[] {
  const grouped = new Map<ProfileCandidateCategory, StableProfileEntry[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.category) ?? [];
    list.push(entry);
    grouped.set(entry.category, list);
  }
  const order: ProfileCandidateCategory[] = [
    "cares",
    "values",
    "epistemic_style",
    "communication",
    "aesthetics",
    "boundaries",
    "agency",
    "identity",
    "narrative",
    "affective_landscape",
    "relationships",
  ];
  const bullets: string[] = [];
  for (const category of order) {
    for (const entry of grouped.get(category) ?? []) {
      bullets.push(locale === "ko"
        ? `${categoryLabelKo(category)}${entry.facet ? `/${facetLabelKo(entry.facet)}` : ""}: ${entry.summary}`
        : `${category}${entry.facet ? `/${entry.facet}` : ""}: ${entry.summary}`);
      if (bullets.length >= 8) return bullets;
    }
  }
  return bullets;
}

function categoryLabelKo(category: ProfileCandidateCategory): string {
  const labels: Record<ProfileCandidateCategory, string> = {
    identity: "정체성",
    cares: "관심",
    values: "가치",
    narrative: "서사",
    agency: "목표",
    epistemic_style: "판단 방식",
    communication: "소통 방식",
    affective_landscape: "정서적 패턴",
    relationships: "관계",
    aesthetics: "취향",
    boundaries: "경계",
  };
  return labels[category];
}

function facetLabelKo(facet: ProfileFacet): string {
  const labels: Partial<Record<ProfileFacet, string>> = {
    current_interests: "최근 관심사",
    enduring_interests: "지속 관심사",
    meaningful_objects: "의미 대상",
    meaningful_events: "의미 사건",
    turning_points: "전환점",
    unresolved_threads: "미해결 주제",
    explicit_values: "명시 가치",
    inferred_values: "추론 가치",
    disliked_values: "거부 가치",
    goals: "목표",
    active_projects: "진행 프로젝트",
    tensions: "긴장",
    how_the_user_thinks: "사고 방식",
    evidence_preference: "근거 선호",
    correction_style: "수정 기대",
    tone_preference: "말투 선호",
    explanation_preference: "설명 선호",
    quality_sense: "품질 감각",
    privacy_rules: "개인정보 규칙",
    consent_required: "동의 필요",
  };
  return labels[facet] ?? facet;
}

function candidatePayload(record: ProfileCandidateRecord): Record<string, unknown> {
  return {
    layer: record.layer,
    facet: record.facet,
    summary: record.summary,
    applies_when: record.applies_when,
    butler_should: record.butler_should,
    butler_should_not: record.butler_should_not,
    temporal_scope: record.temporal_scope,
    decay_policy: record.decay_policy,
    contradiction_refs: record.contradiction_refs,
    sensitivity: record.sensitivity,
    evidence_refs: record.evidence_refs,
    evidence_count: record.evidence_count,
  };
}

function stablePayload(record: StableProfileEntry): Record<string, unknown> {
  return {
    layer: record.layer,
    facet: record.facet,
    summary: record.summary,
    applies_when: record.applies_when,
    butler_should: record.butler_should,
    butler_should_not: record.butler_should_not,
    temporal_scope: record.temporal_scope,
    decay_policy: record.decay_policy,
    contradiction_refs: record.contradiction_refs,
    sensitivity: record.sensitivity,
    evidence_refs: record.evidence_refs,
    evidence_count: record.evidence_count,
    sensitive_domain: record.sensitive_domain,
  };
}

interface ProfileCandidateRow {
  id: string;
  category: string;
  payload_json: string;
  source_type: string;
  confidence: string;
  sensitive_domain: number;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  expires_or_decay: string | null;
  status?: string;
  promoted_at?: string | null;
}

interface StableProfileRow {
  id: string;
  category: string;
  payload_json: string;
  confidence: string;
  source_type: string;
  created_at: string;
  updated_at: string;
}

function recordFromCandidateRow(row: ProfileCandidateRow): ProfileCandidateRecord | null {
  const category = normalizeCategory(row.category);
  if (!category) return null;
  const payload = parsePayload(row.payload_json);
  const summary = typeof payload.summary === "string" ? normalizeSummary(payload.summary) : "";
  if (!summary) return null;
  const evidenceRefs = normalizeEvidenceRefs(payload.evidence_refs);
  const facet = normalizeProfileFacet(payload.facet);
  const defaults = defaultProfileUnderstandingFields(category, facet, summary, row.sensitive_domain === 1);
  return {
    id: row.id,
    layer: normalizeProfileLayer(payload.layer) ?? defaults.layer,
    category,
    facet,
    summary,
    applies_when: normalizeShortStringList(payload.applies_when).length > 0
      ? normalizeShortStringList(payload.applies_when)
      : defaults.applies_when,
    butler_should: normalizeShortStringList(payload.butler_should).length > 0
      ? normalizeShortStringList(payload.butler_should)
      : defaults.butler_should,
    butler_should_not: normalizeShortStringList(payload.butler_should_not).length > 0
      ? normalizeShortStringList(payload.butler_should_not)
      : defaults.butler_should_not,
    temporal_scope: normalizeTemporalScope(payload.temporal_scope) ?? defaults.temporal_scope,
    decay_policy: normalizeDecayPolicy(payload.decay_policy) ?? defaults.decay_policy,
    contradiction_refs: normalizeShortStringList(payload.contradiction_refs),
    sensitivity: normalizeProfileSensitivity(payload.sensitivity) ?? defaults.sensitivity,
    evidence_refs: evidenceRefs,
    evidence_count: typeof payload.evidence_count === "number"
      ? Math.max(payload.evidence_count, evidenceRefs.length)
      : evidenceRefs.length,
    source_type: normalizeSourceType(row.source_type),
    confidence: normalizeConfidence(row.confidence),
    sensitive_domain: row.sensitive_domain === 1,
    status: normalizeCandidateStatus(row.status),
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_seen_at: row.last_seen_at,
    expires_or_decay: row.expires_or_decay === "expires" || row.expires_or_decay === "decay"
      ? row.expires_or_decay
      : null,
    promoted_at: row.promoted_at ?? null,
  };
}

function recordFromStableRow(row: StableProfileRow): StableProfileEntry | null {
  const category = normalizeCategory(row.category);
  if (!category) return null;
  const payload = parsePayload(row.payload_json);
  const summary = typeof payload.summary === "string" ? normalizeSummary(payload.summary) : "";
  if (!summary) return null;
  const evidenceRefs = normalizeEvidenceRefs(payload.evidence_refs);
  const facet = normalizeProfileFacet(payload.facet);
  const defaults = defaultProfileUnderstandingFields(category, facet, summary, payload.sensitive_domain === true);
  return {
    id: row.id,
    layer: normalizeProfileLayer(payload.layer) ?? defaults.layer,
    category,
    facet,
    summary,
    applies_when: normalizeShortStringList(payload.applies_when).length > 0
      ? normalizeShortStringList(payload.applies_when)
      : defaults.applies_when,
    butler_should: normalizeShortStringList(payload.butler_should).length > 0
      ? normalizeShortStringList(payload.butler_should)
      : defaults.butler_should,
    butler_should_not: normalizeShortStringList(payload.butler_should_not).length > 0
      ? normalizeShortStringList(payload.butler_should_not)
      : defaults.butler_should_not,
    temporal_scope: normalizeTemporalScope(payload.temporal_scope) ?? defaults.temporal_scope,
    decay_policy: normalizeDecayPolicy(payload.decay_policy) ?? defaults.decay_policy,
    contradiction_refs: normalizeShortStringList(payload.contradiction_refs),
    sensitivity: normalizeProfileSensitivity(payload.sensitivity) ?? defaults.sensitivity,
    evidence_refs: evidenceRefs,
    evidence_count: typeof payload.evidence_count === "number"
      ? Math.max(payload.evidence_count, evidenceRefs.length)
      : evidenceRefs.length,
    source_type: normalizeSourceType(row.source_type),
    confidence: normalizeConfidence(row.confidence),
    sensitive_domain: payload.sensitive_domain === true,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parsePayload(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeCategory(value: string): ProfileCandidateCategory | null {
  const categories: ProfileCandidateCategory[] = [
    "identity",
    "cares",
    "values",
    "narrative",
    "agency",
    "epistemic_style",
    "communication",
    "affective_landscape",
    "relationships",
    "aesthetics",
    "boundaries",
  ];
  return categories.includes(value as ProfileCandidateCategory)
    ? value as ProfileCandidateCategory
    : null;
}

function normalizeProfileLayer(value: unknown): ProfileLayer | null {
  if (
    value === "stable_disposition" ||
    value === "contextual_adaptation" ||
    value === "current_attention" ||
    value === "narrative_meaning"
  ) {
    return value;
  }
  return null;
}

function normalizeTemporalScope(value: unknown): ProfileTemporalScope | null {
  if (value === "transient" || value === "active" || value === "durable") return value;
  return null;
}

function normalizeDecayPolicy(value: unknown): ProfileDecayPolicy | null {
  if (
    value === "days_7" ||
    value === "days_30" ||
    value === "reinforce_or_decay" ||
    value === "never_without_consent"
  ) {
    return value;
  }
  return null;
}

function normalizeProfileSensitivity(value: unknown): ProfileSensitivity | null {
  if (value === "normal" || value === "sensitive" || value === "restricted") return value;
  return null;
}

function normalizeProfileFacet(value: unknown): ProfileFacet | null {
  if (typeof value !== "string") return null;
  const facets: ProfileFacet[] = [
    "self_descriptions",
    "roles",
    "commitments",
    "current_interests",
    "enduring_interests",
    "meaningful_objects",
    "explicit_values",
    "inferred_values",
    "disliked_values",
    "meaningful_events",
    "turning_points",
    "unresolved_threads",
    "goals",
    "active_projects",
    "tensions",
    "avoidance_patterns",
    "how_the_user_thinks",
    "evidence_preference",
    "uncertainty_tolerance",
    "correction_style",
    "tone_preference",
    "explanation_preference",
    "emotional_mode",
    "energizers",
    "frustrations",
    "comfort_patterns",
    "important_people_or_groups",
    "collaboration_preferences",
    "social_boundaries",
    "taste",
    "anti_taste",
    "quality_sense",
    "privacy_rules",
    "consent_required",
    "sensitive_domains",
  ];
  return facets.includes(value as ProfileFacet) ? value as ProfileFacet : null;
}

function normalizeSourceType(value: string): ProfileSourceType {
  if (
    value === "explicit" ||
    value === "repeated_observation" ||
    value === "inference" ||
    value === "user_confirmed"
  ) {
    return value;
  }
  return "inference";
}

function normalizeConfidence(value: string): ProfileConfidence {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "low";
}

function normalizeCandidateStatus(value: string | undefined): ProfileCandidateStatus {
  if (value === "promoted" || value === "rejected" || value === "expired") return value;
  return "candidate";
}

function normalizeEvidenceRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.replace(/\s+/gu, " ").trim())
      .filter(Boolean)
      .map((item) => item.slice(0, 160)),
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].slice(0, 24);
}

function countRows(db: Database, table: string): number {
  const row = db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: number } | null;
  return typeof row?.count === "number" ? row.count : 0;
}

function iso(date: Date = new Date()): string {
  return date.toISOString();
}
