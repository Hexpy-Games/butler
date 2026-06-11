import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { AttachmentRef, InboundEnvelope, StoredSessionBinding } from "../../test-support/harness/contracts.ts";
import type { GatewayRoute } from "../../gateways/core/contracts.ts";
import { appendPromptAssemblyContextMetric } from "../../operations/metrics/context-monitor.ts";
import {
  promptSectionsText,
  stablePromptPrefixHash,
  stablePromptSections,
} from "../context/prompt-cache-policy.ts";
import { cognitionMemoryRoot } from "../cognition/paths.ts";
import { renderFeedbackBufferContext } from "../cognition/feedback/buffer.ts";
import { projectMemoryPath, refreshProjectCapsule } from "../cognition/memory/project-memory.ts";
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
import { TodoListStore } from "../work/todo-list.ts";
import { WorkStreamStore, type WorkStreamRecord } from "../work/work-stream.ts";

export interface PromptAssemblerOptions {
  butlerHome?: string;
  butlerData?: string;
}

export interface PromptSection {
  id: string;
  title: string;
  content: string;
  region?: ContextRegion;
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
  id: string,
  title: string,
  content: string | null,
  region?: ContextRegion,
): void {
  if (!content) return;
  sections.push({
    id,
    title,
    content,
    region,
  });
}

function joinSections(sections: PromptSection[]): string {
  if (sections.length === 0) return "## Session Role\n\nNo assembled prompt sections were available.";
  return promptSectionsText(sections);
}

function buildDynamicMemorySections(input: {
  butlerData: string;
  projectId?: string;
  workspacePath: string;
}): PromptSection[] {
  const sections: PromptSection[] = [];
  const memoryRoot = cognitionMemoryRoot(input.butlerData);
  const projectMemoryFile = projectMemoryPath({
    butlerData: input.butlerData,
    projectId: input.projectId,
  });
  pushSection(
    sections,
    "hot-cache",
    "Hot Cache",
    readTextIfExists(join(memoryRoot, "hot", "cache.md")),
    "retrieved_context",
  );
  pushSection(
    sections,
    "project-memory",
    "Project Memory",
    projectMemoryFile ? readTextIfExists(projectMemoryFile) : null,
    "retrieved_context",
  );
  pushSection(
    sections,
    "project-hot-cache",
    "Project Hot Cache",
    readTextIfExists(join(input.workspacePath, ".butler", "hot-cache.md")),
    "retrieved_context",
  );
  return sections;
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
    pushSection(
      sections,
      "first-chat-onboarding",
      "First-Chat Onboarding",
      renderFirstChatOnboardingPrompt({
        butlerHome: input.butlerHome,
        butlerData: input.butlerData,
        locale: input.locale,
      }),
      "runtime_state",
    );
  }
  pushSection(
    sections,
    "feedback-buffer",
    "Active Feedback Buffer",
    renderFeedbackBufferContext({
      butlerData: input.butlerData,
      sessionId: input.sessionId,
      projectId: input.projectId,
    }),
    "live_configuration",
  );
  pushSection(
    sections,
    "profile-projection",
    "Profile Projection",
    renderRuntimeProfileProjectionPrompt(
      readRuntimeProfileProjection(input.butlerData),
    ),
    "live_configuration",
  );
  return sections;
}

function buildLiveConfigurationSections(input: {
  butlerHome: string;
  butlerData: string;
  binding: StoredSessionBinding;
}): PromptSection[] {
  const sections: PromptSection[] = [];
  if (input.binding.role === "butler") {
    pushSection(
      sections,
      "eol",
      "Butler Operating Ethos / EOL",
      readTextIfExists(join(input.butlerData, "eol.md")) ??
        readTextIfExists(butlerAgentResourcesPath(input.butlerHome, "eol.md")),
      "live_configuration",
    );
  } else {
    pushSection(
      sections,
      "steward-config",
      "Steward Prompt",
      readTextIfExists(join(input.butlerData, "config", "steward.md")),
      "live_configuration",
    );
  }

  const personaReminder = input.binding.role === "butler"
    ? buildActivePersonaReminderSection(input.butlerData)
    : null;
  if (personaReminder) {
    sections.push({ ...personaReminder, region: "live_configuration" });
  }

  pushSection(
    sections,
    "personalization-profile",
    "Personalization Profile",
    renderPersonalizationProfilePrompt(
      readPersonalizationProfile(input.butlerData),
    ),
    "live_configuration",
  );
  pushSection(
    sections,
    "rules",
    "Active Rules",
    buildRulesContent(join(cognitionMemoryRoot(input.butlerData), "rules")),
    "live_configuration",
  );
  return sections;
}

function hashSections(sections: PromptSection[]): string {
  return createHash("sha256")
    .update(JSON.stringify(sections.map((section) => ({
      id: section.id,
      title: section.title,
      content: section.content,
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
  lines.push(...activeWorkStateLines({
    butlerData: input.butlerData,
    sessionId: input.binding.sessionId,
  }));

  return {
    id: "runtime-state",
    title: "Runtime State",
    content: lines.join("\n"),
    region: "runtime_state",
  };
}

function activeWorkStateLines(input: {
  butlerData: string;
  sessionId: string;
}): string[] {
  const store = new WorkStreamStore(input.butlerData);
  const stream = promptWorkStreamForSession(store, input.sessionId);
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
    const remaining = todo.items
      .filter((item) => item.status !== "completed" && item.status !== "cancelled")
      .slice(0, 8)
      .map((item) => `${item.id}:${item.status}:${item.phase ?? "none"}:${item.active_form}`);
    if (remaining.length > 0) {
      lines.push("Open Todo Items:");
      lines.push(...remaining.map((line) => `- ${line}`));
    }
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

function promptWorkStreamForSession(
  store: WorkStreamStore,
  sessionId: string,
): WorkStreamRecord | null {
  const active = store.activeForSession(sessionId);
  if (active) return active;
  const latest = store.list({ sessionId, includeTerminal: true }).at(0);
  return latest?.state === "failed" ? store.read(latest.id) : null;
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

function buildCurrentAttachmentReferenceSection(envelope: InboundEnvelope): PromptSection | null {
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

  private buildStaticContextSections(binding: StoredSessionBinding): PromptSection[] {
    const sections: PromptSection[] = [];

    pushSection(
      sections,
      "runtime-system-contract",
      "Runtime System Contract",
      readTextIfExists(butlerAgentResourcesPath(this.butlerHome, "prompts", "runtime-system-contract.md")),
      "static_context",
    );

    if (binding.role === "butler") {
      pushSection(
        sections,
        "role",
        "Butler Role Rules",
        readTextIfExists(butlerAgentResourcesPath(this.butlerHome, "prompts", "butler.md")),
        "static_context",
      );
    } else {
      pushSection(
        sections,
        "role",
        "Steward Role Rules",
        readTextIfExists(butlerAgentResourcesPath(this.butlerHome, "prompts", "steward.md")),
        "static_context",
      );
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
    if (binding.role !== "steward" || !binding.projectId) return { status: "skipped" };
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
    const assembly = this.buildContextAssembly(input);
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
    const config = readPromptButlerConfig(this.butlerData);
    const liveConfiguration = buildLiveConfigurationSections({
      butlerHome: this.butlerHome,
      butlerData: this.butlerData,
      binding: input.binding,
    });
    const liveConfigHash = hashSections(liveConfiguration);
    const personalization = buildDynamicPersonalizationSections({
      butlerHome: this.butlerHome,
      butlerData: this.butlerData,
      sessionId: input.binding.sessionId,
      role: input.binding.role,
      locale: promptLocale(config),
      projectId: input.binding.projectId,
    });
    const runtimeState = [
      buildRuntimeStateSection({
        ...input,
        config,
        liveConfigHash,
        butlerData: this.butlerData,
        projectMemoryStatus: this.projectCapsuleStatus(input.binding),
      }),
      ...personalization.filter((section) => section.region === "runtime_state"),
    ];
    const retrievedContext = [
      ...buildDynamicMemorySections({
        butlerData: this.butlerData,
        projectId: input.binding.projectId,
        workspacePath: input.binding.workspacePath,
      }),
    ];
    const livePersonalization = personalization.filter((section) => section.region === "live_configuration");
    const currentAttachmentReferences = buildCurrentAttachmentReferenceSection(input.envelope);
    return {
      staticContext: this.buildStaticContextSections(input.binding),
      liveConfiguration: [
        ...liveConfiguration,
        ...livePersonalization,
      ],
      runtimeState,
      workingContext: currentAttachmentReferences ? [currentAttachmentReferences] : [],
      retrievedContext,
      currentInput: [
        buildCurrentInputSection({ envelope: input.envelope }),
      ],
      references: attachmentReferencesFromEnvelope(input.envelope),
      liveConfigHash,
    };
  }
}
