import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { cognitionConsolidationRoot } from "../paths.ts";
import {
  DEFAULT_MODEL_REF,
  DEFAULT_REASONING_EFFORT,
  type ReasoningEffort,
} from "../../../integrations/providers/model-catalog.ts";
import { parseModelRef } from "../../../integrations/providers/model-ref.ts";
import {
  runPromptTextWithUsage,
  type PromptUsageReport,
} from "../../../integrations/providers/provider.ts";
import {
  listStableProfileEntries,
  readRuntimeProfileProjection,
  type RuntimeProfileProjection,
  type StableProfileEntry,
} from "../../../personalization/profiling.ts";
import {
  emptyModelUsageSummary,
  usageFromPromptUsageReports,
  type ConsolidationModelUsageSummary,
} from "./usage.ts";

export type NewChatBriefingLocale = "ko" | "en";
export type NewChatBriefingScope = "general" | "project";
export type NewChatBriefingTitleBucket =
  | "morning"
  | "afternoon"
  | "evening"
  | "night";

export type NewChatBriefingSuggestionSourceKind =
  | "unfinished_topic"
  | "repeated_question"
  | "current_interest"
  | "adjacent_direction"
  | "timely_context"
  | "project_status"
  | "project_decision"
  | "project_quality_risk"
  | "project_next_step";

export interface NewChatBriefingSuggestionArtifact {
  id: string;
  title: string;
  description: string;
  text: string;
  source_kind: NewChatBriefingSuggestionSourceKind;
}

export interface NewChatBriefingArtifact {
  schema: "butler.cognition.new-chat-briefing.v1";
  briefing_id: string;
  scope: NewChatBriefingScope;
  project_id: string | null;
  project_name: string | null;
  locale: NewChatBriefingLocale;
  moment: string;
  title: string;
  title_variants?: Record<NewChatBriefingTitleBucket, string>;
  description: string;
  suggestions: NewChatBriefingSuggestionArtifact[];
  source: {
    consolidation_run_id: string;
    generated_at: string;
    persona_id: string | null;
    persona_applied: boolean;
    profile_projection_id: string | null;
    profile_projection_updated_at: string | null;
    project_ledger_snapshot_id: string | null;
    model_ref: string;
    reasoning_effort: ReasoningEffort;
    raw_text_included: false;
  };
  raw_text_included: false;
}

export interface NewChatBriefingModelRunnerInput {
  model: string;
  reasoningEffort: ReasoningEffort;
  instructions: string;
  prompt: string;
  cacheScope: string;
  butlerData: string;
  signal?: AbortSignal;
}

export interface NewChatBriefingModelRunnerResult {
  text: string;
  usage?: PromptUsageReport | null;
  model?: string | null;
}

export type NewChatBriefingModelRunner = (
  input: NewChatBriefingModelRunnerInput,
) => Promise<string | NewChatBriefingModelRunnerResult>;

export interface GenerateNewChatBriefingsInput {
  butlerData: string;
  runId: string;
  now?: Date;
  modelRunner?: NewChatBriefingModelRunner;
  signal?: AbortSignal;
}

export interface NewChatBriefingGenerationMetrics extends Record<string, unknown> {
  generated_count: number;
  failed_count: number;
  skipped_project_count: number;
  general_artifact_path: string | null;
  project_artifact_paths: string[];
  model_ref: string;
  reasoning_effort: ReasoningEffort;
  model_usage: ConsolidationModelUsageSummary;
  raw_text_included: false;
}

interface AppProjectSignal {
  id: string;
  displayName: string;
  recentSessionTitles: string[];
  ledgerEventSummary: string[];
}

interface ParsedModelOutput {
  moment?: unknown;
  title?: unknown;
  title_variants?: unknown;
  description?: unknown;
  suggestions?: unknown;
}

const ARTIFACT_SCHEMA = "butler.cognition.new-chat-briefing.v1" as const;
const TITLE_BUCKETS = ["morning", "afternoon", "evening", "night"] as const;
const MAX_PERSONA_CHARS = 2_400;
const MAX_PROFILE_ITEMS = 18;
const MAX_PROJECTS_PER_RUN = 12;
const ALLOWED_SOURCE_KINDS = new Set<NewChatBriefingSuggestionSourceKind>([
  "unfinished_topic",
  "repeated_question",
  "current_interest",
  "adjacent_direction",
  "timely_context",
  "project_status",
  "project_decision",
  "project_quality_risk",
  "project_next_step",
]);

export function newChatBriefingArtifactPath(input: {
  butlerData: string;
  date: string;
  scope: NewChatBriefingScope;
  projectId?: string | null;
}): string {
  const root = join(cognitionConsolidationRoot(input.butlerData), "briefings", input.date);
  if (input.scope === "general") return join(root, "general.json");
  return join(root, "projects", `${safeProjectIdSegment(input.projectId ?? "project")}.json`);
}

export function readNewChatBriefingArtifact(input: {
  butlerData: string;
  date?: string | null;
  scope: NewChatBriefingScope;
  projectId?: string | null;
  locale?: NewChatBriefingLocale | null;
}): NewChatBriefingArtifact | null {
  const dates = input.date?.trim()
    ? [input.date.trim()]
    : latestBriefingDates(input.butlerData);
  for (const date of dates) {
    const artifact = readJsonFile<NewChatBriefingArtifact>(newChatBriefingArtifactPath({
      butlerData: input.butlerData,
      date,
      scope: input.scope,
      projectId: input.projectId,
    }));
    if (!isValidNewChatBriefingArtifact(artifact)) continue;
    if (artifact.scope !== input.scope) continue;
    if (input.scope === "project" && artifact.project_id !== (input.projectId ?? null)) continue;
    if (input.locale && artifact.locale !== input.locale) continue;
    return artifact;
  }
  return null;
}

export async function generateNewChatBriefings(
  input: GenerateNewChatBriefingsInput,
): Promise<NewChatBriefingGenerationMetrics> {
  const now = input.now ?? new Date();
  const date = datePart(now.toISOString());
  const settings = readBriefingSettings(input.butlerData);
  if (!settings.configured && !input.modelRunner) {
    return {
      generated_count: 0,
      failed_count: 0,
      skipped_project_count: 0,
      general_artifact_path: null,
      project_artifact_paths: [],
      model_ref: settings.model,
      reasoning_effort: settings.reasoningEffort,
      model_usage: emptyModelUsageSummary(),
      raw_text_included: false,
    };
  }
  const locale = settings.locale;
  const persona = readActivePersona(input.butlerData);
  const projection = safeReadRuntimeProjection(input.butlerData);
  const stableEntries = safeListStableEntries(input.butlerData);
  const modelReports: Array<{ model: string; usage?: PromptUsageReport | null }> = [];
  const runner = input.modelRunner ?? defaultNewChatBriefingModelRunner;
  const generatedAt = now.toISOString();
  let generatedCount = 0;
  let failedCount = 0;
  let skippedProjectCount = 0;
  let generalArtifactPath: string | null = null;
  const projectArtifactPaths: string[] = [];

  const runOne = async (scopeInput: {
    scope: NewChatBriefingScope;
    project?: AppProjectSignal;
  }): Promise<NewChatBriefingArtifact | null> => {
    const cacheScope = `cognition:${input.runId}:new_chat_briefing:${scopeInput.scope}${
      scopeInput.project ? `:${safeProjectIdSegment(scopeInput.project.id)}` : ""
    }`;
    const prompt = buildBriefingPrompt({
      locale,
      now,
      runId: input.runId,
      persona,
      projection,
      stableEntries,
      project: scopeInput.project,
    });
    const raw = normalizeRunnerOutput(await runner({
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      instructions: briefingInstructions(locale, Boolean(persona.text)),
      prompt,
      cacheScope,
      butlerData: input.butlerData,
      signal: input.signal,
    }));
    modelReports.push({
      model: raw.model || settings.model,
      usage: raw.usage,
    });
    const parsed = parseModelJson(raw.text);
    return artifactFromModelOutput({
      parsed,
      scope: scopeInput.scope,
      locale,
      now,
      generatedAt,
      runId: input.runId,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      persona,
      projection,
      project: scopeInput.project,
    });
  };

  try {
    const artifact = await runOne({ scope: "general" });
    if (artifact) {
      generalArtifactPath = writeNewChatBriefingArtifact(input.butlerData, date, artifact);
      generatedCount += 1;
    }
  } catch {
    failedCount += 1;
  }

  const projects = listActiveProjectSignals(input.butlerData).slice(0, MAX_PROJECTS_PER_RUN);
  for (const project of projects) {
    if (project.recentSessionTitles.length === 0 && project.ledgerEventSummary.length === 0) {
      skippedProjectCount += 1;
      continue;
    }
    try {
      const artifact = await runOne({ scope: "project", project });
      if (artifact) {
        projectArtifactPaths.push(writeNewChatBriefingArtifact(input.butlerData, date, artifact));
        generatedCount += 1;
      }
    } catch {
      failedCount += 1;
    }
  }

  return {
    generated_count: generatedCount,
    failed_count: failedCount,
    skipped_project_count: skippedProjectCount,
    general_artifact_path: generalArtifactPath,
    project_artifact_paths: projectArtifactPaths,
    model_ref: settings.model,
    reasoning_effort: settings.reasoningEffort,
    model_usage: modelReports.length > 0
      ? usageFromPromptUsageReports(modelReports)
      : emptyModelUsageSummary(),
    raw_text_included: false,
  };
}

function writeNewChatBriefingArtifact(
  butlerData: string,
  date: string,
  artifact: NewChatBriefingArtifact,
): string {
  const path = newChatBriefingArtifactPath({
    butlerData,
    date,
    scope: artifact.scope,
    projectId: artifact.project_id,
  });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

function artifactFromModelOutput(input: {
  parsed: ParsedModelOutput;
  scope: NewChatBriefingScope;
  locale: NewChatBriefingLocale;
  now: Date;
  generatedAt: string;
  runId: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  persona: { id: string | null; text: string | null };
  projection: RuntimeProfileProjection | null;
  project?: AppProjectSignal;
}): NewChatBriefingArtifact {
  const suggestions = normalizeSuggestions(input.parsed.suggestions, input.scope);
  if (suggestions.length < 4) {
    throw new Error("new chat briefing model returned fewer than four valid suggestions");
  }
  return {
    schema: ARTIFACT_SCHEMA,
    briefing_id: `ncb_${randomUUID()}`,
    scope: input.scope,
    project_id: input.project?.id ?? null,
    project_name: input.project?.displayName ?? null,
    locale: input.locale,
    moment: normalizeString(input.parsed.moment) || formatMoment(input.now, input.locale),
    title: requiredString(input.parsed.title, "title"),
    ...(input.scope === "general"
      ? { title_variants: requiredTitleVariants(input.parsed.title_variants) }
      : {}),
    description: requiredString(input.parsed.description, "description"),
    suggestions,
    source: {
      consolidation_run_id: input.runId,
      generated_at: input.generatedAt,
      persona_id: input.persona.id,
      persona_applied: Boolean(input.persona.text),
      profile_projection_id: input.projection ? "active" : null,
      profile_projection_updated_at: input.projection?.updated_at ?? null,
      project_ledger_snapshot_id: input.project ? `${input.project.id}:safe-summary` : null,
      model_ref: input.model,
      reasoning_effort: input.reasoningEffort,
      raw_text_included: false,
    },
    raw_text_included: false,
  };
}

function normalizeSuggestions(value: unknown, scope: NewChatBriefingScope): NewChatBriefingSuggestionArtifact[] {
  if (!Array.isArray(value)) return [];
  const suggestions: NewChatBriefingSuggestionArtifact[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const input = item as Record<string, unknown>;
    const title = normalizeString(input.title);
    const description = normalizeString(input.description);
    const text = normalizeString(input.text);
    if (!title || !description || !text) continue;
    const sourceKind = normalizeSourceKind(input.source_kind, scope);
    const id = safeSuggestionId(normalizeString(input.id) || title);
    if (seen.has(id)) continue;
    seen.add(id);
    suggestions.push({ id, title, description, text, source_kind: sourceKind });
    if (suggestions.length >= 6) break;
  }
  return suggestions;
}

function normalizeSourceKind(value: unknown, scope: NewChatBriefingScope): NewChatBriefingSuggestionSourceKind {
  if (typeof value === "string" && ALLOWED_SOURCE_KINDS.has(value as NewChatBriefingSuggestionSourceKind)) {
    return value as NewChatBriefingSuggestionSourceKind;
  }
  return scope === "project" ? "project_next_step" : "current_interest";
}

function buildBriefingPrompt(input: {
  locale: NewChatBriefingLocale;
  now: Date;
  runId: string;
  persona: { id: string | null; text: string | null };
  projection: RuntimeProfileProjection | null;
  stableEntries: StableProfileEntry[];
  project?: AppProjectSignal;
}): string {
  const isProjectBriefing = Boolean(input.project);
  const profileHints = isProjectBriefing
    ? []
    : input.stableEntries
        .slice()
        .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
        .slice(0, MAX_PROFILE_ITEMS)
        .map((entry) => ({
          category: entry.category,
          facet: entry.facet,
          summary: entry.summary,
          should: entry.butler_should.slice(0, 3),
          should_not: entry.butler_should_not.slice(0, 3),
        }));
  const payload = {
    task: input.project ? "project_new_chat_briefing" : "general_new_chat_briefing",
    locale: input.locale,
    now: input.now.toISOString(),
    time_of_day: timeOfDay(input.now),
    consolidation_run_id: input.runId,
    persona: input.persona.text
      ? {
          id: input.persona.id,
          excerpt: input.persona.text.slice(0, MAX_PERSONA_CHARS),
        }
      : null,
    runtime_projection: input.projection
      ? {
          updated_at: input.projection.updated_at,
          how_to_answer: input.projection.how_to_answer.slice(0, 8),
          how_to_collaborate: input.projection.how_to_collaborate.slice(0, 8),
          response_hints: input.projection.response_hints.slice(0, 8),
          current_attention: isProjectBriefing
            ? []
            : input.projection.current_attention.slice(0, 10),
          active_boundaries: input.projection.active_boundaries.slice(0, 8),
          likely_failure_modes: input.projection.likely_failure_modes.slice(0, 6),
        }
      : null,
    profile_summaries: profileHints,
    project: input.project
      ? {
          id: input.project.id,
          name: input.project.displayName,
          recent_session_titles: input.project.recentSessionTitles,
          ledger_event_summary: input.project.ledgerEventSummary,
        }
      : null,
    scope_rules: input.project
      ? [
          "Every suggestion must be directly about the selected project.",
          "Use only the project id/name and project summaries as topic sources.",
          "Do not introduce general interests, meals, entertainment, news, or unrelated personal topics unless the project summaries explicitly mention them.",
          "If project signal is thin, make fewer sharper project cards instead of filling with generic topics.",
        ]
      : [
          "Use general user-level signals, unfinished topics, repeated questions, current interests, adjacent directions, and timely context.",
          "Do not turn unfinished work into pressure or obligation.",
        ],
    output_shape: {
      moment: "short time label",
      title: "one short fallback greeting or question for the surface",
      ...(input.project
        ? {}
        : {
            title_variants: {
              morning: "surface headline for local morning",
              afternoon: "surface headline for local afternoon",
              evening: "surface headline for local evening",
              night: "surface headline for local night",
            },
          }),
      description: "one short sentence about why these cards are here",
      suggestions: [{
        id: "stable-kebab-id",
        title: "topic name",
        description: "why this is useful to open",
        text: "message to send if selected",
        source_kind: "one allowed source kind",
      }],
    },
  };
  return JSON.stringify(payload, null, 2);
}

function briefingInstructions(locale: NewChatBriefingLocale, hasPersona: boolean): string {
  const language = locale === "ko" ? "Korean" : "English";
  return [
    "You generate Butler's New Chat Briefing artifact.",
    `Write visible copy in ${language}.`,
    "Return JSON only. Do not wrap it in Markdown.",
    "The title is the page headline: a short greeting or question, not a status label.",
    "For general briefings, include title_variants with morning, afternoon, evening, and night; these are also page headlines.",
    "For project briefings, do not include time-of-day title variants.",
    "Each card title names a topic. Each card description says why opening it may be useful.",
    "Do not pressure the user, create urgency, shame unfinished work, or tell the user what they must do.",
    "Do not describe the interface, the memory system, the prompt, the persona, or why you generated the artifact.",
    "Do not include raw transcript text, filesystem paths, private reasoning, or provider payloads.",
    "Create 4 to 6 suggestions.",
    hasPersona
      ? "Apply the active persona subtly in phrasing, without turning the page into a performance."
      : "Use neutral Butler copy because no persona text was supplied.",
  ].join("\n");
}

async function defaultNewChatBriefingModelRunner(
  input: NewChatBriefingModelRunnerInput,
): Promise<NewChatBriefingModelRunnerResult> {
  return await runPromptTextWithUsage({
    prompt: input.prompt,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    instructions: input.instructions,
    cacheScope: input.cacheScope,
    butlerData: input.butlerData,
    signal: input.signal,
  });
}

function normalizeRunnerOutput(
  output: string | NewChatBriefingModelRunnerResult,
): NewChatBriefingModelRunnerResult {
  return typeof output === "string" ? { text: output } : output;
}

function parseModelJson(raw: string): ParsedModelOutput {
  const text = raw.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("new chat briefing model did not return a JSON object");
  return JSON.parse(text.slice(start, end + 1)) as ParsedModelOutput;
}

function readBriefingSettings(butlerData: string): {
  locale: NewChatBriefingLocale;
  model: string;
  reasoningEffort: ReasoningEffort;
  configured: boolean;
} {
  const settings = readButlerSettings(butlerData);
  return {
    locale: settings.language === "ko" ? "ko" : "en",
    model: normalizeModelRef(settings.consolidation_model) ?? normalizeModelRef(settings.model) ?? DEFAULT_MODEL_REF,
    reasoningEffort: normalizeReasoningEffort(settings.consolidation_reasoning_effort) ??
      normalizeReasoningEffort(settings.reasoning_effort) ??
      DEFAULT_REASONING_EFFORT,
    configured: Object.keys(settings).length > 0,
  };
}

function readButlerSettings(butlerData: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(join(butlerData, "butler.config.json"), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function listActiveProjectSignals(butlerData: string): AppProjectSignal[] {
  const ledgerProjects = listProjectsFromLedger(butlerData);
  const byId = new Map<string, AppProjectSignal>();
  for (const project of ledgerProjects) {
    byId.set(project.id, {
      ...project,
      recentSessionTitles: uniqueStrings([
        ...project.recentSessionTitles,
        ...(byId.get(project.id)?.recentSessionTitles ?? []),
      ]).slice(0, 8),
      ledgerEventSummary: uniqueStrings([
        ...project.ledgerEventSummary,
        ...(byId.get(project.id)?.ledgerEventSummary ?? []),
      ]).slice(0, 12),
    });
  }
  return [...byId.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function listProjectsFromLedger(butlerData: string): AppProjectSignal[] {
  const root = join(butlerData, "project-ledger", "projects");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const project = readJsonFile<{ id?: string; name?: string }>(join(root, entry.name, "project.json"));
      const id = project?.id || entry.name;
      return {
        id,
        displayName: project?.name || id,
        recentSessionTitles: [],
        ledgerEventSummary: ledgerEventSummary(butlerData, id),
      };
    });
}

function ledgerEventSummary(butlerData: string, projectId: string): string[] {
  const path = join(butlerData, "project-ledger", "projects", safeProjectIdSegment(projectId), "ledger.jsonl");
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).slice(-80);
    const counts = new Map<string, number>();
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as { type?: unknown; id?: unknown; status?: unknown; kind?: unknown };
        if (typeof event.type !== "string") continue;
        const key = [event.type, event.kind, event.status].filter((item) => typeof item === "string").join(":");
        counts.set(key, (counts.get(key) ?? 0) + 1);
      } catch {
        continue;
      }
    }
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 12)
      .map(([key, count]) => `${key} x${count}`);
  } catch {
    return [];
  }
}

function readActivePersona(butlerData: string): { id: string | null; text: string | null } {
  const path = join(butlerData, "personas", "active.md");
  if (!existsSync(path)) return { id: null, text: null };
  try {
    const text = readFileSync(path, "utf8").trim();
    return {
      id: "active",
      text: text || null,
    };
  } catch {
    return { id: null, text: null };
  }
}

function safeReadRuntimeProjection(butlerData: string): RuntimeProfileProjection | null {
  try {
    return readRuntimeProfileProjection(butlerData);
  } catch {
    return null;
  }
}

function safeListStableEntries(butlerData: string): StableProfileEntry[] {
  try {
    return listStableProfileEntries(butlerData);
  } catch {
    return [];
  }
}

function isValidNewChatBriefingArtifact(value: unknown): value is NewChatBriefingArtifact {
  if (!value || typeof value !== "object") return false;
  const artifact = value as NewChatBriefingArtifact;
  return artifact.schema === ARTIFACT_SCHEMA &&
    (artifact.scope === "general" || artifact.scope === "project") &&
    (artifact.locale === "ko" || artifact.locale === "en") &&
    typeof artifact.title === "string" &&
    isValidTitleVariants(artifact.title_variants) &&
    typeof artifact.description === "string" &&
    Array.isArray(artifact.suggestions) &&
    artifact.suggestions.length >= 4 &&
    artifact.raw_text_included === false &&
    artifact.source?.raw_text_included === false;
}

function requiredTitleVariants(value: unknown): Record<NewChatBriefingTitleBucket, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("new chat briefing model omitted title_variants");
  }
  const input = value as Record<NewChatBriefingTitleBucket, unknown>;
  return {
    morning: requiredString(input.morning, "title_variants.morning"),
    afternoon: requiredString(input.afternoon, "title_variants.afternoon"),
    evening: requiredString(input.evening, "title_variants.evening"),
    night: requiredString(input.night, "title_variants.night"),
  };
}

function isValidTitleVariants(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<NewChatBriefingTitleBucket, unknown>;
  return TITLE_BUCKETS.every((bucket) => normalizeString(input[bucket]).length > 0);
}

function latestBriefingDates(butlerData: string): string[] {
  const root = join(cognitionConsolidationRoot(butlerData), "briefings");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/u.test(entry.name))
    .map((entry) => ({
      date: entry.name,
      mtime: safeMtime(join(root, entry.name)),
    }))
    .sort((left, right) => right.date.localeCompare(left.date) || right.mtime - left.mtime)
    .map((entry) => entry.date);
}

export function safeProjectIdSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]/gu, "_").replace(/_+/gu, "_") || "project";
}

function safeSuggestionId(value: string): string {
  return value.toLocaleLowerCase("en-US")
    .trim()
    .replace(/[^a-z0-9가-힣._-]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80) || `card-${randomUUID().slice(0, 8)}`;
}

function normalizeModelRef(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = parseModelRef(value);
  return parsed.modelId ? parsed.canonicalRef : null;
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | null {
  return value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : null;
}

function requiredString(value: unknown, label: string): string {
  const normalized = normalizeString(value);
  if (!normalized) throw new Error(`new chat briefing model omitted ${label}`);
  return normalized;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function datePart(value: string): string {
  return value.slice(0, 10);
}

function formatMoment(date: Date, locale: NewChatBriefingLocale): string {
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function timeOfDay(date: Date): string {
  const hour = date.getHours();
  if (hour < 6) return "night";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  if (hour < 22) return "evening";
  return "night";
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
