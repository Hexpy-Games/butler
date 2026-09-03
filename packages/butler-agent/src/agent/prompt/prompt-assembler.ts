import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join } from "path";
import type { AttachmentRef, InboundEnvelope, StoredSessionBinding } from "../../test-support/harness/contracts.ts";
import type { GatewayRoute } from "../../gateways/core/contracts.ts";
import { appendPromptAssemblyContextMetric } from "../../operations/metrics/context-monitor.ts";
import {
  promptSectionsText,
  stablePromptPrefixHash,
  stablePromptSections,
} from "../context/prompt-cache-policy.ts";
import type {
  ContextProjectionClass,
  ContextScopeKind,
} from "../context/context-projection.ts";
import { cognitionMemoryRoot } from "../cognition/paths.ts";
import { renderScopedFeedbackBufferContexts } from "../cognition/feedback/buffer.ts";
import { projectMemoryPath, refreshProjectCapsule } from "../cognition/memory/project-memory.ts";
import { sessionContinuityPath } from "../cognition/continuity/continuity-store.ts";
import {
  readPersonalizationProfile,
  renderPersonalizationProfilePrompt,
} from "../../personalization/profile.ts";
import {
  readRuntimeProfileProjection,
  renderRuntimeProfileProjectionPrompt,
} from "../../personalization/profiling.ts";
import { butlerAgentResourcesPath } from "../../runtime/paths.ts";
import { renderFirstChatOnboardingPrompt } from "../../personalization/onboarding.ts";
import { TaskStore, type TaskSummary } from "../work/task-store.ts";
import { TodoListStore, type TodoItem } from "../work/todo-list.ts";
import { WorkStreamStore, type WorkStreamRecord, workStreamResumable } from "../work/work-stream.ts";

export interface PromptAssemblerOptions {
  butlerHome?: string;
  butlerData?: string;
}

export interface PromptSection {
  id: string;
  title: string;
  content: string;
  region?: ContextRegion;
  projectionClass: ContextProjectionClass;
  scopeKind: ContextScopeKind;
}

export interface AssembledPrompt {
  systemPrompt: string;
  sections: PromptSection[];
}

export type ContextRegion =
  | "static_context"
  | "live_configuration"
  | "runtime_state"
  | "working_context"
  | "retrieved_context"
  | "current_input";

export interface ContextReference {
  kind:
    | "event"
    | "message"
    | "attachment"
    | "artifact"
    | "tool_output"
    | "task"
    | "worker"
    | "work_stream"
    | "project_document";
  id: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextAssembly {
  staticContext: PromptSection[];
  liveConfiguration: PromptSection[];
  runtimeState: PromptSection[];
  workingContext: PromptSection[];
  retrievedContext: PromptSection[];
  currentInput: PromptSection[];
  references: ContextReference[];
  liveConfigHash: string;
}

export type ProjectCapsuleEnsureResult =
  | { status: "skipped" }
  | { status: "present"; path: string }
  | { status: "created"; path: string }
  | { status: "failed"; error: string };

export type ProjectCapsuleStatus = "skipped" | "present" | "missing";

interface PromptUserConfig {
  timezone?: string;
  language?: string;
  responseLanguage?: string;
  techLanguage?: string;
  location?: unknown;
  geo?: unknown;
}

interface PromptButlerConfig {
  user?: PromptUserConfig;
}

function getButlerHome(explicit?: string): string {
  return explicit || process.env.BUTLER_HOME || process.cwd();
}

function getButlerData(_butlerHome: string, explicit?: string): string {
  return explicit || process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function readTextIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8").trim();
  return text ? text : null;
}

function readPromptButlerConfig(butlerData: string): PromptButlerConfig {
  const text = readTextIfExists(join(butlerData, "butler.config.json"));
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as PromptButlerConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function parseRuleLinks(indexText: string): string[] {
  const paths: string[] = [];
  for (const line of indexText.split("\n")) {
    const match = line.match(/\(([^)]+\.md)\)/);
    if (match?.[1]) paths.push(match[1]);
  }
  return paths;
}

function buildRulesContent(rulesDir: string): string | null {
  const indexPath = join(rulesDir, "INDEX.md");
  const indexText = readTextIfExists(indexPath);
  if (!indexText) return null;

  const blocks: string[] = [];
  for (const relativePath of parseRuleLinks(indexText)) {
    const resolved = join(rulesDir, relativePath);
    const content = readTextIfExists(resolved);
    if (!content) continue;
    blocks.push(`### ${relativePath}\n\n${content}`);
  }

  if (blocks.length === 0) return null;
  return blocks.join("\n\n---\n\n");
}

function pushSection(
  sections: PromptSection[],
  section: Omit<PromptSection, "content"> & { content: string | null },
): void {
  if (!section.content) return;
  sections.push({ ...section, content: section.content });
}

function joinSections(sections: PromptSection[]): string {
  if (sections.length === 0) return "## Session Role\n\nNo assembled prompt sections were available.";
  return promptSectionsText(sections);
}

function buildDynamicMemorySections(input: {
  butlerData: string;
  projectId?: string;
  sessionId: string;
  workspacePath: string;
}): PromptSection[] {
  const sections: PromptSection[] = [];
  const memoryRoot = cognitionMemoryRoot(input.butlerData);
  const projectMemoryFile = projectMemoryPath({
    butlerData: input.butlerData,
    projectId: input.projectId,
  });
  const projectMemory = projectMemoryFile
    ? readTextIfExists(projectMemoryFile)
    : null;
  pushSection(sections, {
    id: "hot-cache",
    title: "Hot Cache",
    content: readTextIfExists(join(memoryRoot, "hot", "cache.md")),
    region: "retrieved_context",
    projectionClass: "mandatory_hot_cache",
    scopeKind: "user",
  });
  pushSection(sections, {
    id: "session-continuity",
    title: "Session Continuity",
    content: readTextIfExists(sessionContinuityPath(input.butlerData, input.sessionId)),
    region: "retrieved_context",
    projectionClass: "optional_hot_cache",
    scopeKind: "session",
  });
  pushSection(sections, {
    id: "project-memory",
    title: "Project Memory",
    content: projectMemory,
    region: "retrieved_context",
    projectionClass: "optional_hot_cache",
    scopeKind: "project",
  });
  pushSection(sections, {
    id: "project-hot-cache",
    title: "Project Hot Cache",
    content: projectHotCache(input.workspacePath, projectMemory),
    region: "retrieved_context",
    projectionClass: "mandatory_hot_cache",
    scopeKind: input.projectId ? "project" : "session",
  });
  return sections;
}

function projectHotCache(workspacePath: string, projectMemory: string | null): string | null {
  const sessionCache = readTextIfExists(join(workspacePath, ".butler", "hot-cache.md"));
  if (sessionCache) return sessionCache;
  const canonicalPath = projectMemory
    ?.match(/^- canonical_path:\s*(.+)$/mu)?.[1]
    ?.trim();
  if (!canonicalPath || !isAbsolute(canonicalPath)) return null;
  return readTextIfExists(join(canonicalPath, ".butler", "hot-cache.md"));
}

function buildDynamicPersonalizationSections(input: {
  butlerHome: string;
  butlerData: string;
  sessionId: string;
  role: StoredSessionBinding["role"];
  locale: "en" | "ko";
  projectId?: string;
}): PromptSection[] {
  const sections: PromptSection[] = [];
  if (input.role === "butler") {
    pushSection(sections, {
      id: "first-chat-onboarding",
      title: "First-Chat Onboarding",
      content: renderFirstChatOnboardingPrompt({
        butlerHome: input.butlerHome,
        butlerData: input.butlerData,
        locale: input.locale,
      }),
      region: "runtime_state",
      projectionClass: "profile",
      scopeKind: "user",
    });
  }
  pushSection(sections, {
    id: "profile-projection",
    title: "Profile Projection",
    content: renderRuntimeProfileProjectionPrompt(
      readRuntimeProfileProjection(input.butlerData),
    ),
    region: "live_configuration",
    projectionClass: "profile",
    scopeKind: "user",
  });
  return sections;
}

function buildLiveConfigurationSections(input: {
  butlerHome: string;
  butlerData: string;
  binding: StoredSessionBinding;
}): PromptSection[] {
  const sections: PromptSection[] = [];
  if (input.binding.role !== "butler") {
    pushSection(sections, {
      id: "steward-config",
      title: "Steward Prompt",
      content: readTextIfExists(join(input.butlerData, "config", "steward.md")),
      region: "live_configuration",
      projectionClass: "optional_hot_cache",
      scopeKind: input.binding.projectId ? "project" : "session",
    });
  }

  const personaReminder = input.binding.role === "butler"
    ? buildActivePersonaReminderSection(input.butlerData)
    : null;
  if (personaReminder) {
    sections.push({ ...personaReminder, region: "live_configuration" });
  }

  pushSection(sections, {
    id: "personalization-profile",
    title: "Personalization Profile",
    content: renderPersonalizationProfilePrompt(
      readPersonalizationProfile(input.butlerData),
    ),
    region: "live_configuration",
    projectionClass: "profile",
    scopeKind: "user",
  });
  return sections;
}

function buildEolSections(input: {
  butlerHome: string;
  butlerData: string;
}): PromptSection[] {
  const sections: PromptSection[] = [];
  pushSection(sections, {
    id: "eol",
    title: "Butler Operating Ethos / EOL",
    content: readTextIfExists(join(input.butlerData, "eol.md")) ??
      readTextIfExists(butlerAgentResourcesPath(input.butlerHome, "eol.md")),
    region: "live_configuration",
    projectionClass: "profile",
    scopeKind: "user",
  });
  return sections;
}

function hashSections(sections: PromptSection[]): string {
  return createHash("sha256")
    .update(JSON.stringify(sections.map((section) => ({
      id: section.id,
      title: section.title,
      content: section.content,
      projectionClass: section.projectionClass,
      scopeKind: section.scopeKind,
    }))))
    .digest("hex")
    .slice(0, 16);
}

function promptLocale(config: PromptButlerConfig): "en" | "ko" {
  const language = (safeConfigText(config.user?.responseLanguage) ||
    safeConfigText(config.user?.language)).toLocaleLowerCase("en-US");
  if (/\bko\b|\bkor\b|korean|한국|한국어/u.test(language)) return "ko";
  return "en";
}

function buildActivePersonaReminderSection(butlerData: string): PromptSection | null {
  const activePersona = readTextIfExists(join(butlerData, "personas", "active.md"));
  if (!activePersona) return null;
  const boundedPersona = activePersona.length > 3_000
    ? `${activePersona.slice(0, 3_000).trimEnd()}\n...`
    : activePersona;
  return {
    id: "active-persona-reminder",
    title: "Active Persona Reminder",
    region: "live_configuration",
    projectionClass: "profile",
    scopeKind: "user",
    content: [
      "Use this current persona for every user-facing answer in this turn.",
      "Use the configured Assistant Response Language from the Turn Environment for every final answer and visible status text.",
      "Preserve the persona's tone and signature speech patterns; if the persona text is written in another language, translate or adapt that voice into the configured response language.",
      "For long answers, carry the persona through section bodies and the closing, not only the opening sentence.",
      "Do not let tool, review, or report formatting instructions erase the persona.",
      "",
      boundedPersona,
    ].join("\n"),
  };
}

function buildRuntimeStateSection(input: {
  binding: StoredSessionBinding;
  envelope: InboundEnvelope;
  route?: GatewayRoute;
  config: PromptButlerConfig;
  liveConfigHash: string;
  butlerData: string;
  projectMemoryStatus?: ProjectCapsuleStatus;
  includeLegacyWorkState: boolean;
}): PromptSection {
  const lines = [
    `Live Configuration Hash: ${input.liveConfigHash}`,
    `Session ID: ${input.binding.sessionId}`,
    `Session Role: ${input.binding.role}`,
  ];
  lines.push(...buildTurnEnvironmentContext({
    envelope: input.envelope,
    config: input.config,
  }));

  if (input.binding.projectId) {
    lines.push(`Project ID: ${input.binding.projectId}`);
    if (input.projectMemoryStatus) {
      lines.push(`Project Memory Status: ${input.projectMemoryStatus}`);
    }
  }
  lines.push(`Workspace Path: ${input.binding.workspacePath}`);
  if (input.includeLegacyWorkState) {
    lines.push(...activeWorkStateLines({
      butlerData: input.butlerData,
      sessionId: input.binding.sessionId,
      projectId: input.binding.projectId ?? null,
    }));
  }

  return {
    id: "runtime-state",
    title: "Runtime State",
    content: lines.join("\n"),
    region: "runtime_state",
    projectionClass: "mandatory_hot_cache",
    scopeKind: "session",
  };
}

function activeWorkStateLines(input: {
  butlerData: string;
  sessionId: string;
  projectId?: string | null;
}): string[] {
  const store = new WorkStreamStore(input.butlerData);
  const stream = promptWorkStreamForSession(store, input.sessionId, input.projectId);
  if (!stream) return [];
  const lines = [
    "## Active Work State",
    `WorkStream ID: ${stream.id}`,
    `WorkStream Title: ${stream.title}`,
    `WorkStream State: ${stream.state}`,
    `WorkStream Phase: ${stream.current_phase ?? "none"}`,
  ];
  if (stream.active_step_id) lines.push(`Active Step ID: ${stream.active_step_id}`);
  if (shouldShowActiveWorkStatusNote(stream)) {
    lines.push(`Status Note: ${stream.status_note}`);
  }
  if (stream.todo_list_id) {
    const todo = new TodoListStore(input.butlerData).view(stream.todo_list_id, { includeCompleted: true });
    lines.push(`Todo List ID: ${todo.list.list_id}`);
    if (todo.progress.current) {
      lines.push(`Current Todo: ${todo.progress.current.active_form}`);
    }
    const resumeTodo = resumableTodo(todo.items, stream.active_step_id);
    if (resumeTodo) {
      lines.push(
        `Resume From Todo: ${resumeTodo.id}:${resumeTodo.status}:${resumeTodo.phase ?? "none"}:${resumeTodo.active_form}`,
      );
    }
    const remaining = todo.items
      .filter((item) => item.status !== "completed" && item.status !== "cancelled")
      .slice(0, 8)
      .map((item) => `${item.id}:${item.status}:${item.phase ?? "none"}:${item.active_form}`);
    if (remaining.length > 0) {
      lines.push("Open Todo Items:");
      lines.push(...remaining.map((line) => `- ${line}`));
    }
    lines.push(...activeWorkContinuationContractLines({
      stream,
      todoListId: todo.list.list_id,
      resumeTodo,
      openItemCount: remaining.length,
    }));
  }
  const taskStore = new TaskStore(input.butlerData);
  const summariesById = new Map(taskStore.summaries(250).map((summary) => [summary.task_id, summary]));
  const workerSummaries = stream.linked_worker_task_ids
    .slice(0, 8)
    .map((taskId) => summariesById.get(taskId))
    .filter((summary): summary is TaskSummary => Boolean(summary));
  if (workerSummaries.length > 0) {
    lines.push("Linked Workers:");
    for (const worker of workerSummaries) {
      const statusLine = worker.activity_status_line || worker.activity_current_title || worker.user_summary;
      lines.push(`- ${worker.task_id}: ${worker.status}; ${worker.activity_phase ?? worker.work_mode}; ${statusLine}`);
    }
  }
  if (stream.linked_planned_task_ids.length > 0) {
    lines.push(`Linked Planned Tasks: ${stream.linked_planned_task_ids.slice(0, 12).join(", ")}`);
  }
  if (stream.linked_orchestration_ids.length > 0) {
    lines.push(`Linked Orchestrations: ${stream.linked_orchestration_ids.slice(0, 12).join(", ")}`);
  }
  return lines;
}

function resumableTodo(items: TodoItem[], activeStepId: string | null): TodoItem | null {
  const activeStep = activeStepId
    ? items.find((item) => item.id === activeStepId) ?? null
    : null;
  if (activeStep && activeStep.status !== "completed" && activeStep.status !== "cancelled") {
    return activeStep;
  }
  return items.find((item) => item.status === "in_progress") ??
    items.find((item) => item.status === "pending") ??
    null;
}

function activeWorkContinuationContractLines(input: {
  stream: WorkStreamRecord;
  todoListId: string;
  resumeTodo: TodoItem | null;
  openItemCount: number;
}): string[] {
  if (!workStreamResumable(input.stream) || input.openItemCount === 0) return [];
  const lines = [
    "Continuation Contract:",
    `- Primary Target: existing WorkStream ${input.stream.id} and Todo List ${input.todoListId}.`,
  ];
  if (input.resumeTodo) {
    lines.push(
      `- Next Step: ${input.resumeTodo.id}:${input.resumeTodo.status}:${input.resumeTodo.phase ?? "none"}:${input.resumeTodo.active_form}`,
    );
  }
  lines.push(
    "- If the current user input asks to continue or resume this session's work, update this existing todo list instead of creating a new turn-scoped checklist.",
    "- If the next step is pending because a previous turn became recoverable, restore that step to in_progress and execute it before broad validation, review, or replanning.",
    "- Do not replace open planning or execution steps with a new inspection/review/validation plan; review only after the existing WorkStream reaches its review or reporting phase.",
  );
  return lines;
}

function promptWorkStreamForSession(
  store: WorkStreamStore,
  sessionId: string,
  projectId?: string | null,
): WorkStreamRecord | null {
  const projectScope = projectId?.trim();
  const active = store.listActive({ sessionId, projectId: projectScope }).at(0);
  if (active) return store.read(active.id);
  const latest = store.list({ sessionId, projectId: projectScope, includeTerminal: true }).at(0);
  if (!latest) return null;
  if (
    latest.state === "paused" ||
    latest.state === "waiting_user" ||
    latest.state === "failed" ||
    latest.state === "recoverable"
  ) {
    return store.read(latest.id);
  }
  return null;
}

function shouldShowActiveWorkStatusNote(stream: WorkStreamRecord): boolean {
  const note = stream.status_note?.trim();
  if (!note) return false;
  if (
    stream.state === "paused" ||
    stream.state === "waiting_user" ||
    stream.state === "failed" ||
    stream.state === "recoverable"
  ) {
    return true;
  }
  return !isRuntimeControlStatusNote(note);
}

function isRuntimeControlStatusNote(note: string): boolean {
  return /\b(?:final delivery blocked|previous answer|non-deliverable|interrupted before final delivery|active direct work stream is not deliverable)\b/iu
    .test(note);
}

function buildCurrentInputSection(input: {
  envelope: InboundEnvelope;
}): PromptSection {
  const lines = [
    `Message Text: ${input.envelope.message.text?.trim() || ""}`,
  ];
  return {
    id: "inbound-message",
    title: "Current User Input",
    content: lines.join("\n"),
    region: "current_input",
    projectionClass: "optional_hot_cache",
    scopeKind: "session",
  };
}

function attachmentReferencesFromEnvelope(envelope: InboundEnvelope): ContextReference[] {
  const attachments = Array.isArray(envelope.message.attachments)
    ? envelope.message.attachments
    : [];
  return attachments
    .filter((attachment): attachment is AttachmentRef => Boolean(attachment?.id))
    .slice(0, 12)
    .map((attachment) => ({
      kind: "attachment",
      id: attachment.id,
      label: attachment.fileName,
      metadata: {
        kind: attachment.kind,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      },
    }));
}

function buildCurrentAttachmentReferenceSection(input: {
  envelope: InboundEnvelope;
  binding: StoredSessionBinding;
}): PromptSection | null {
  const envelope = input.envelope;
  const attachments = Array.isArray(envelope.message.attachments)
    ? envelope.message.attachments
    : [];
  const lines = attachments
    .filter((attachment): attachment is AttachmentRef => Boolean(attachment?.id))
    .slice(0, 12)
    .map((attachment, index) => {
      const name = attachment.fileName?.trim() || `attachment-${index + 1}`;
      const kind = attachment.kind || "binary";
      const mime = attachment.mimeType?.trim() || "application/octet-stream";
      const size = Number.isFinite(attachment.sizeBytes) ? `${attachment.sizeBytes} bytes` : "unknown size";
      return `- ${name} (${kind}, ${mime}, ${size}, attachment_id: ${attachment.id})`;
    });
  if (lines.length === 0) return null;
  return {
    id: "current-attachments",
    title: "Current Attachment References",
    content: lines.join("\n"),
    region: "working_context",
    projectionClass: "optional_hot_cache",
    scopeKind: input.binding.projectId ? "project" : "session",
  };
}

function projectMemoryStatus(input: {
  butlerData: string;
  projectId?: string;
}): ProjectCapsuleStatus | null {
  const path = projectMemoryPath({
    butlerData: input.butlerData,
    projectId: input.projectId,
  });
  if (!path) return null;
  return existsSync(path) ? "present" : "missing";
}

function buildTurnEnvironmentContext(input: {
  envelope: InboundEnvelope;
  config: PromptButlerConfig;
}): string[] {
  const user = input.config.user ?? {};
  const timestamp = parseTurnTimestamp(input.envelope.message.timestamp);
  const timezone = safeConfigText(user.timezone) || "UTC";
  const language = safeConfigText(user.language) || "unknown";
  const responseLanguage = safeConfigText(user.responseLanguage) || language;
  const techLanguage = safeConfigText(user.techLanguage);
  const geoHint = bestGeoHint(user, timezone);
  const localTime = formatLocalTime(timestamp, timezone);
  const lines = [
    "## Turn Environment",
    `Current Time UTC: ${timestamp.toISOString()}`,
    `Current Local Time: ${localTime}`,
    `User Timezone: ${timezone}`,
    `User Language: ${language}`,
    `Assistant Response Language: ${responseLanguage}`,
  ];
  if (techLanguage) lines.push(`User Technical Language: ${techLanguage}`);
  lines.push(`User Geo Hint: ${geoHint}`);
  return lines;
}

function parseTurnTimestamp(value: string | undefined): Date {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function formatLocalTime(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "full",
      timeStyle: "long",
      timeZone: timezone,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function bestGeoHint(user: PromptUserConfig, timezone: string): string {
  const envHint = safeConfigText(process.env.BUTLER_USER_GEO);
  if (envHint) return envHint;
  const location = stringifyGeo(user.location);
  if (location) return location;
  const geo = stringifyGeo(user.geo);
  if (geo) return geo;
  return `Not configured; timezone hint only: ${timezone}`;
}

function stringifyGeo(value: unknown): string {
  if (typeof value === "string") return safeConfigText(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  return [
    record.city,
    record.region,
    record.country,
    record.countryCode,
  ]
    .map((part) => safeConfigText(part))
    .filter(Boolean)
    .join(", ");
}

function safeConfigText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/gu, " ").trim().slice(0, 180);
}

export class PromptAssembler {
  private readonly butlerHome: string;
  private readonly butlerData: string;

  constructor(options: PromptAssemblerOptions = {}) {
    this.butlerHome = getButlerHome(options.butlerHome);
    this.butlerData = getButlerData(this.butlerHome, options.butlerData);
  }

  private buildRuntimeSystemContext(): PromptSection[] {
    const sections: PromptSection[] = [];

    pushSection(sections, {
      id: "runtime-system-contract",
      title: "Runtime System Contract",
      content: readTextIfExists(butlerAgentResourcesPath(this.butlerHome, "prompts", "runtime-system-contract.md")),
      region: "static_context",
      projectionClass: "profile",
      scopeKind: "user",
    });
    return sections;
  }

  private buildStaticContextSections(binding: StoredSessionBinding): PromptSection[] {
    const sections = this.buildRuntimeSystemContext();

    if (binding.role === "butler") {
      pushSection(sections, {
        id: "role",
        title: "Butler Role Rules",
        content: readTextIfExists(butlerAgentResourcesPath(this.butlerHome, "prompts", "butler.md")),
        region: "static_context",
        projectionClass: "profile",
        scopeKind: "user",
      });
    } else {
      pushSection(sections, {
        id: "role",
        title: "Steward Role Rules",
        content: readTextIfExists(butlerAgentResourcesPath(this.butlerHome, "prompts", "steward.md")),
        region: "static_context",
        projectionClass: "profile",
        scopeKind: "user",
      });
    }

    return sections;
  }

  buildSystemPrompt(binding: StoredSessionBinding): AssembledPrompt {
    const sections = this.buildStaticContextSections(binding);
    const systemPrompt = joinSections(sections);
    const stableSections = stablePromptSections(sections);
    try {
      appendPromptAssemblyContextMetric({
        butlerData: this.butlerData,
        sessionId: binding.sessionId,
        role: binding.role,
        sections,
        systemPrompt,
        stablePrefixChars: joinSections(stableSections).length,
        stablePrefixHash: stablePromptPrefixHash(sections),
      });
    } catch {
      // Context telemetry must never block prompt assembly.
    }

    return {
      sections,
      systemPrompt,
    };
  }

  ensureProjectCapsule(binding: StoredSessionBinding): ProjectCapsuleEnsureResult {
    if (!binding.projectId) return { status: "skipped" };
    const path = projectMemoryPath({
      butlerData: this.butlerData,
      projectId: binding.projectId,
    });
    if (!path) return { status: "skipped" };
    if (existsSync(path)) return { status: "present", path };

    try {
      const result = refreshProjectCapsule({
        butlerData: this.butlerData,
        projectId: binding.projectId,
        workspacePath: binding.workspacePath,
      });
      return { status: "created", path: result.path };
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  projectCapsuleStatus(binding: StoredSessionBinding): ProjectCapsuleStatus {
    if (!binding.projectId) return "skipped";
    return projectMemoryStatus({
      butlerData: this.butlerData,
      projectId: binding.projectId,
    }) ?? "skipped";
  }

  buildTurnContext(input: {
    binding: StoredSessionBinding;
    envelope: InboundEnvelope;
    route?: GatewayRoute;
  }): string {
    return this.renderTurnContext(this.buildContextAssembly(input));
  }

  renderTurnContext(assembly: ContextAssembly): string {
    const dynamicSections = [
      ...assembly.liveConfiguration,
      ...assembly.runtimeState,
      ...assembly.workingContext,
      ...assembly.retrievedContext,
      ...assembly.currentInput,
    ];
    if (dynamicSections.length === 0) {
      return `Live Configuration Hash: ${assembly.liveConfigHash}`;
    }

    return [
      `Live Configuration Hash: ${assembly.liveConfigHash}`,
      joinSections(dynamicSections),
    ].join("\n\n---\n\n");
  }

  buildContextAssembly(input: {
    binding: StoredSessionBinding;
    envelope: InboundEnvelope;
    route?: GatewayRoute;
  }): ContextAssembly {
    return this.buildContextAssemblyForRuntime(input, true);
  }

  buildButlerContextAssembly(input: {
    binding: StoredSessionBinding;
    envelope: InboundEnvelope;
    route?: GatewayRoute;
  }): ContextAssembly {
    return this.buildContextAssemblyForRuntime(input, false);
  }

  buildStewardContextAssembly(input: {
    binding: StoredSessionBinding;
    envelope: InboundEnvelope;
  }): ContextAssembly {
    return this.buildSharedContextAssembly(input, false);
  }

  private buildSharedContextAssembly(input: {
    binding: StoredSessionBinding;
    envelope: InboundEnvelope;
  }, includeLegacyWorkState: boolean, roleConfiguration: PromptSection[] = []): ContextAssembly {
    const liveConfiguration = buildEolSections({
      butlerHome: this.butlerHome,
      butlerData: this.butlerData,
    });
    pushSection(liveConfiguration, {
      id: "rules",
      title: "Active Rules",
      content: buildRulesContent(join(cognitionMemoryRoot(this.butlerData), "rules")),
      region: "live_configuration",
      projectionClass: "mandatory_hot_cache",
      scopeKind: "user",
    });
    for (const { scopeKind, content } of renderScopedFeedbackBufferContexts({
      butlerData: this.butlerData,
      sessionId: input.binding.sessionId,
      projectId: input.binding.projectId,
    })) {
      pushSection(liveConfiguration, {
        id: scopeKind === "user" ? "feedback-buffer" : `${scopeKind}-feedback-buffer`,
        title: "Active Feedback Buffer",
        content,
        region: "live_configuration",
        projectionClass: "recent_feedback",
        scopeKind,
      });
    }
    liveConfiguration.push(...roleConfiguration);
    const liveConfigHash = hashSections(liveConfiguration);
    return {
      staticContext: this.buildRuntimeSystemContext(),
      liveConfiguration,
      runtimeState: [buildRuntimeStateSection({
        ...input,
        config: readPromptButlerConfig(this.butlerData),
        liveConfigHash,
        butlerData: this.butlerData,
        projectMemoryStatus: this.projectCapsuleStatus(input.binding),
        includeLegacyWorkState,
      })],
      workingContext: [],
      retrievedContext: [],
      currentInput: [],
      references: [],
      liveConfigHash,
    };
  }

  private buildContextAssemblyForRuntime(input: {
    binding: StoredSessionBinding;
    envelope: InboundEnvelope;
    route?: GatewayRoute;
  }, includeLegacyWorkState: boolean): ContextAssembly {
    const config = readPromptButlerConfig(this.butlerData);
    const roleConfiguration = buildLiveConfigurationSections({
      butlerHome: this.butlerHome,
      butlerData: this.butlerData,
      binding: input.binding,
    });
    const personalization = buildDynamicPersonalizationSections({
      butlerHome: this.butlerHome,
      butlerData: this.butlerData,
      sessionId: input.binding.sessionId,
      role: input.binding.role,
      locale: promptLocale(config),
      projectId: input.binding.projectId,
    });
    const common = this.buildSharedContextAssembly(input, includeLegacyWorkState, [
      ...roleConfiguration,
      ...personalization.filter((section) => section.region === "live_configuration"),
    ]);
    const runtimeState = [
      ...common.runtimeState,
      ...personalization.filter((section) => section.region === "runtime_state"),
    ];
    const retrievedContext = [
      ...buildDynamicMemorySections({
        butlerData: this.butlerData,
        projectId: input.binding.projectId,
        sessionId: input.binding.sessionId,
        workspacePath: input.binding.workspacePath,
      }),
    ];
    const currentAttachmentReferences = buildCurrentAttachmentReferenceSection(input);
    return {
      staticContext: this.buildStaticContextSections(input.binding),
      liveConfiguration: common.liveConfiguration,
      runtimeState,
      workingContext: currentAttachmentReferences ? [currentAttachmentReferences] : [],
      retrievedContext,
      currentInput: [
        buildCurrentInputSection({ envelope: input.envelope }),
      ],
      references: attachmentReferencesFromEnvelope(input.envelope),
      liveConfigHash: common.liveConfigHash,
    };
  }
}
