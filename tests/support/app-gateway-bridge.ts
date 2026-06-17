import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  AgentRuntimeAdapter,
  ModelProviderAdapter,
  StoredSessionBinding,
} from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import type {
  ArtifactRef,
  AttachmentRef,
  InboundEnvelope,
  OutboundAction,
} from "../../packages/butler-agent/src/gateways/core/contracts.ts";
import {
  APP_ACCOUNT,
  APP_SENDER_ID,
  APP_TRANSPORT,
  createAppInboundEnvelope,
} from "../../packages/butler-agent/src/gateways/core/app-transport.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { GatewayRouter } from "../../packages/butler-agent/src/gateways/core/router.ts";
import { createGatewayServer } from "../../packages/butler-agent/src/gateways/core/server.ts";
import { createLifecycleGatewayHandlers, SessionLifecycleService } from "../../packages/butler-agent/src/interfaces/gateway/session-lifecycle.ts";
import { PromptAssembler } from "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import { PolicyEngine } from "../../packages/butler-agent/src/agent/policy/policy-engine.ts";
import {
  generateSessionTitleWithProvider,
  normalizeModelRef,
  type SessionTitleGenerator,
} from "../../packages/butler-agent/src/agent/output/session-title.ts";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import { runPromptText } from "../../packages/butler-agent/src/integrations/providers/provider.ts";
import { completeReportingWorkStreamForSession } from "../../packages/butler-agent/src/agent/work/work-stream.ts";
import { loadPrivateEnvIntoProcess } from "../../packages/butler-agent/src/interfaces/cli/private-env.ts";
import {
  applyComponentUpdate,
  checkComponentUpdates,
  renderServiceUpdateResult,
} from "../../packages/butler-agent/src/operations/update/component-updater.ts";
import type { RuntimeTurnEventInput } from "../../packages/butler-agent/src/agent/events/turn-events.ts";
import type { AppMessageResponder, AppMessageResponderFile, AppMessageResponderInput, AppMessageResponderResult } from "../../packages/butler-agent/src/gateways/app/store.ts";

const APP_SESSION_ID = "butler/app-general";

interface ButlerConfig {
  system?: {
    runtime?: string;
    butlerModel?: string;
    defaultModel?: string;
  };
}

type WorkerModelRuleInput = NonNullable<AppMessageResponderInput["workerModelRules"]>[number];
export interface AppGatewayBridgeOptions {
  butlerHome?: string;
  butlerData?: string;
  runtime?: AgentRuntimeAdapter;
  provider?: ModelProviderAdapter;
  runtimePolicy?: Record<string, unknown>;
  sessionTitleGenerator?: SessionTitleGenerator | false;
}

export class AppGatewayBridge {
  readonly responder: AppMessageResponder = async (input) => this.respond(input);
  private readonly butlerHome: string;
  private readonly butlerData: string;
  private readonly runtime: AgentRuntimeAdapter;
  private readonly provider: ModelProviderAdapter;
  private readonly runtimePolicy?: Record<string, unknown>;
  private readonly sessionTitleGenerator: SessionTitleGenerator | false;
  private readonly store: SessionBindingStore;
  private readonly server: ReturnType<typeof createGatewayServer>;
  private readonly visibleDeliveries = new Map<string, string[]>();
  private readonly visibleProgress = new Map<string, NonNullable<AppMessageResponderInput["onProgress"]>>();
  private readonly visibleTurnEvents = new Map<string, NonNullable<AppMessageResponderInput["onTurnEvent"]>>();

  constructor(options: AppGatewayBridgeOptions = {}) {
    this.butlerHome = options.butlerHome ?? process.env.BUTLER_HOME ?? process.cwd();
    this.butlerData = options.butlerData ?? process.env.BUTLER_DATA ?? join(homedir(), ".butler");
    this.runtime = options.runtime ?? new NativeToolLoopRuntime({
      butlerHome: this.butlerHome,
      butlerData: this.butlerData,
    });
    this.provider = options.provider ?? defaultProvider();
    this.runtimePolicy = options.runtimePolicy;
    this.sessionTitleGenerator = options.sessionTitleGenerator ??
      ((titleInput) => generateSessionTitleWithProvider(this.provider, titleInput));
    this.store = new SessionBindingStore(join(this.butlerData, "runtime", "session-store.sqlite"));
    this.ensureAppSession();

    const router = new GatewayRouter({ store: this.store });
    const lifecycle = new SessionLifecycleService({
      store: this.store,
      runtime: this.runtime,
      provider: this.provider,
      promptAssembler: new PromptAssembler({ butlerHome: this.butlerHome, butlerData: this.butlerData }),
      policyEngine: new PolicyEngine(),
      deliverIntermediate: async (delivery) => this.collectIntermediate(delivery.action, delivery.metadata),
      deliverTurnEvent: async (delivery) => this.collectTurnEvent(delivery.envelope, delivery.event),
    });
    this.server = createGatewayServer({
      router,
      handlers: createLifecycleGatewayHandlers(lifecycle),
      butlerData: this.butlerData,
    });
  }

  close(): void {
    this.store.close();
  }

  private async respond(input: AppMessageResponderInput): Promise<AppMessageResponderResult> {
    const updateAction = parseUpdateCommand(input.text);
    if (updateAction) return await this.handleUpdateCommand(updateAction);
    this.ensureAppSession(input);
    const envelope = toInboundEnvelope(input);
    this.visibleDeliveries.set(envelope.eventId, []);
    if (input.onProgress) this.visibleProgress.set(envelope.eventId, input.onProgress);
    if (input.onTurnEvent) this.visibleTurnEvents.set(envelope.eventId, input.onTurnEvent);
    const abortListener = () => {
      this.visibleDeliveries.delete(envelope.eventId);
      this.visibleProgress.delete(envelope.eventId);
      this.visibleTurnEvents.delete(envelope.eventId);
    };
    input.signal?.addEventListener("abort", abortListener, { once: true });
    try {
      await this.publishGeneratedSessionTitle(input);
      const result = await this.server.handleInbound(envelope);
      const intermediate = this.visibleDeliveries.get(envelope.eventId) ?? [];

      if (result.status !== "handled") {
        return { texts: [`Butler gateway could not route this message: ${result.status}`] };
      }
      const finalText = typeof result.handlerResult.metadata?.text === "string"
        ? result.handlerResult.metadata.text
        : "";
      if ([finalText, ...intermediate].some((text) => text.trim())) {
        this.completeReportingWorkStreamBestEffort(sessionIdForChat(input.chatId));
      }
      const files = this.materializeArtifactFiles(
        artifactRefsFromMetadata(result.handlerResult.metadata?.artifacts),
        input,
      );
      return {
        texts: dedupeTexts([...intermediate, finalText]),
        files,
      };
    } finally {
      input.signal?.removeEventListener("abort", abortListener);
      this.visibleDeliveries.delete(envelope.eventId);
      this.visibleProgress.delete(envelope.eventId);
      this.visibleTurnEvents.delete(envelope.eventId);
    }
  }

  private async publishGeneratedSessionTitle(input: AppMessageResponderInput): Promise<void> {
    if (!input.onSessionTitle || !this.sessionTitleGenerator) return;
    const text = input.text.trim();
    if (!text) return;
    try {
      if (input.signal?.aborted) return;
      const title = await this.sessionTitleGenerator({
        text,
        model: normalizeModelRef(input.model),
        signal: input.signal,
      });
      if (input.signal?.aborted) return;
      if (title) input.onSessionTitle(title);
    } catch {
      // Title generation is presentation polish; it must not block the turn.
    }
  }

  private async handleUpdateCommand(action: "check" | "apply"): Promise<AppMessageResponderResult> {
    try {
      if (action === "apply") {
        const result = await applyComponentUpdate({
          root: this.butlerHome,
          butlerData: this.butlerData,
          component: "service",
        });
        return { texts: [renderServiceUpdateResult(result)] };
      }
      const view = await checkComponentUpdates({
        root: this.butlerHome,
        butlerData: this.butlerData,
        components: ["service"],
      });
      return { texts: [renderServiceUpdateResult(view.components[0]!)] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { texts: [`Butler Agent update failed: ${message}`] };
    }
  }

  private completeReportingWorkStreamBestEffort(sessionId: string): void {
    try {
      completeReportingWorkStreamForSession({
        butlerData: this.butlerData,
        sessionId,
        statusNote: "Final app response delivered.",
      });
    } catch {
      // App response delivery must not fail because of terminal WorkStream bookkeeping.
    }
  }

  private ensureAppSession(input?: AppMessageResponderInput): StoredSessionBinding {
    const config = readButlerConfig(this.butlerData);
    const modelRef = normalizeModelRef(input?.model ?? config.system?.butlerModel ?? config.system?.defaultModel);
    const chatId = input?.chatId ?? "general";
    const sessionId = sessionIdForChat(chatId);
    const projectId = input?.projectId ?? (chatId === "project-butler" ? "butler" : undefined);
    return this.store.upsert({
      sessionId,
      role: "butler",
      projectId,
      workspacePath: input?.projectWorkspacePath ?? this.butlerHome,
      runtimeAdapterId: this.runtime.id,
      modelProviderId: modelRef.split("/", 1)[0] || this.provider.id,
      modelRef,
      lifecycleState: "active",
      transportBindings: [
        {
          transport: APP_TRANSPORT,
          accountId: APP_ACCOUNT,
          peerId: chatId,
        },
      ],
      metadata: {
        source: "app-server",
        appSessionKind: input?.sessionKind ?? "chat",
        accessMode: input?.accessMode ?? "full_access",
        runtimePolicy: appBridgeRuntimePolicy({
          existing: this.runtimePolicy,
          accessMode: input?.accessMode,
        }),
        workerModelRules: safeWorkerModelRules(input?.workerModelRules),
      },
    });
  }

  private collectIntermediate(action: OutboundAction, metadata?: Record<string, unknown>): void {
    const eventId = matchingVisibleEventId(action.actionId, [
      ...this.visibleProgress.keys(),
      ...this.visibleDeliveries.keys(),
    ]);
    const progress = progressRowFromIntermediate(action, metadata);
    if (progress) {
      const publish = eventId ? this.visibleProgress.get(eventId) : undefined;
      if (publish) publish(progress);
    }
    // Durable message state belongs to AppServerStore; this buffer only mirrors visible text for the active turn.
    const text = action.message.text?.trim();
    if (!text || action.presence) return;
    if (eventId) {
      const texts = this.visibleDeliveries.get(eventId);
      if (texts) {
        texts.push(text);
        this.visibleDeliveries.set(eventId, texts);
      }
    }
  }

  private collectTurnEvent(
    envelope: InboundEnvelope,
    event: RuntimeTurnEventInput,
  ): void {
    this.visibleTurnEvents.get(envelope.eventId)?.(event);
  }

  private materializeArtifactFiles(
    artifacts: ArtifactRef[],
    input: AppMessageResponderInput,
  ): AppMessageResponderFile[] {
    const allowedRoots = [
      this.butlerData,
      input.projectWorkspacePath ?? this.butlerHome,
    ]
      .map((root) => resolve(root))
      .filter((root, index, roots) => roots.indexOf(root) === index);
    const files: AppMessageResponderFile[] = [];
    const seen = new Set<string>();
    for (const artifact of artifacts) {
      const localPath = artifact.localPath?.trim();
      if (!localPath) continue;
      const resolvedPath = resolve(localPath);
      if (seen.has(resolvedPath)) continue;
      if (!allowedRoots.some((root) => isPathInsideRoot(resolvedPath, root))) continue;
      if (!existsSync(resolvedPath)) continue;
      seen.add(resolvedPath);
      files.push({
        name: safeArtifactFileName(artifact, resolvedPath),
        mimeType: artifact.mimeType ?? mimeTypeForPath(resolvedPath),
        bytes: readFileSync(resolvedPath),
      });
    }
    return files;
  }
}

export function createDefaultAppGatewayBridge(options: AppGatewayBridgeOptions = {}): AppGatewayBridge {
  const butlerData = options.butlerData ?? process.env.BUTLER_DATA ?? join(homedir(), ".butler");
  loadPrivateEnvIntoProcess(butlerData);
  return new AppGatewayBridge({ ...options, butlerData });
}

function toInboundEnvelope(input: AppMessageResponderInput): InboundEnvelope {
  return createAppInboundEnvelope({
    signal: input.signal,
    accountId: APP_ACCOUNT,
    peerKind: "dm",
    chatId: input.chatId,
    messageId: input.messageId,
    turnId: input.turnId,
    text: input.text,
    timestamp: new Date().toISOString(),
    sessionId: sessionIdForChat(input.chatId),
    senderId: APP_SENDER_ID,
    senderDisplayName: "Butler App",
    projectId: input.projectId,
    attachments: input.attachments?.map(messageFileToAttachmentRef),
    rawSource: "app-server",
  });
}

function safeWorkerModelRules(
  rules: AppMessageResponderInput["workerModelRules"],
): WorkerModelRuleInput[] {
  if (!Array.isArray(rules)) return [];
  return rules
    .filter((rule): rule is WorkerModelRuleInput =>
      Boolean(
        rule &&
        typeof rule === "object" &&
        typeof rule.model === "string" &&
        rule.model.trim() &&
        rule.enabled !== false,
      ),
    )
    .map((rule) => ({
      id: rule.id,
      label: rule.label,
      condition: rule.condition,
      model: rule.model,
      reasoning_effort: rule.reasoning_effort,
      enabled: rule.enabled,
    }))
    .slice(0, 12);
}

function messageFileToAttachmentRef(file: NonNullable<AppMessageResponderInput["attachments"]>[number]): AttachmentRef {
  return {
    id: file.file_id,
    kind: file.kind === "image" ? "image" : file.kind === "text" ? "document" : "binary",
    mimeType: file.mime_type,
    fileName: file.safe_name,
    sizeBytes: file.size_bytes,
    url: file.url,
    metadata: {
      source: "message-file-store",
      createdAt: file.created_at,
    },
  };
}

function artifactRefsFromMetadata(value: unknown): ArtifactRef[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({
      id: safeText(item.id, `artifact-${randomUUID().slice(0, 8)}`),
      kind: artifactKind(item.kind),
      title: safeText(item.title, "Artifact"),
      safePathLabel: safeOptionalText(item.safePathLabel),
      mimeType: safeOptionalText(item.mimeType),
      localPath: safeOptionalLocalPath(item.localPath),
      url: safeOptionalText(item.url),
      sizeBytes: typeof item.sizeBytes === "number" && Number.isFinite(item.sizeBytes)
        ? item.sizeBytes
        : undefined,
      createdAt: safeOptionalText(item.createdAt),
    }));
}

function safeArtifactFileName(artifact: ArtifactRef, localPath: string): string {
  const title = artifact.safePathLabel?.trim() || artifact.title.trim() || basename(localPath);
  return basename(title) || basename(localPath) || "artifact";
}

function artifactKind(value: unknown): ArtifactRef["kind"] {
  if (
    value === "csv_file" ||
    value === "table_file" ||
    value === "chart_file" ||
    value === "image" ||
    value === "document" ||
    value === "code" ||
    value === "report" ||
    value === "file"
  ) {
    return value;
  }
  return "unknown";
}

function isPathInsideRoot(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
}

function mimeTypeForPath(path: string): string {
  const ext = extname(path).toLocaleLowerCase("en-US");
  if (ext === ".csv") return "text/csv";
  if (ext === ".tsv") return "text/tab-separated-values";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".json") return "application/json";
  if (ext === ".html") return "text/html";
  if (ext === ".md" || ext === ".txt") return "text/plain";
  return "application/octet-stream";
}

type ProgressRowInput = Parameters<NonNullable<AppMessageResponderInput["onProgress"]>>[0];

function matchingVisibleEventId(actionId: string, eventIds: string[]): string | null {
  return eventIds.find((eventId) => actionId.startsWith(`runtime-intermediate:${eventId}:`)) ?? null;
}

function progressRowFromIntermediate(
  action: OutboundAction,
  metadata?: Record<string, unknown>,
): ProgressRowInput | null {
  const actionMetadata = action.metadata ?? {};
  const kind = metadata?.kind ?? actionMetadata.kind;
  if (kind === "todo_progress") {
    const label = safeText(actionMetadata.safeLabel ?? metadata?.safeLabel, "Working step");
    const phase = safeTodoPhase(actionMetadata.phase ?? metadata?.phase);
    const todoId = safeOptionalText(actionMetadata.todoId ?? metadata?.todoId);
    const order = safeOptionalNumber(actionMetadata.safeOrder ?? metadata?.safeOrder);
    return {
      id: `progress-${randomUUID()}`,
      kind: "todo",
      state: safeProgressState(actionMetadata.state ?? metadata?.state),
      safe_label: label,
      ...(todoId ? { safe_input_label: todoId } : {}),
      ...(order != null ? { safe_order: order } : {}),
      safe_detail_rows: phase
        ? [{
            id: "phase",
            kind: "phase",
            safe_label: "Phase",
            safe_value: todoPhaseLabel(phase),
            state: safeProgressState(actionMetadata.state ?? metadata?.state),
          }]
        : undefined,
    };
  }
  if (kind === "tool_progress") {
    const activityKind = safeProgressKind(actionMetadata.activityKind ?? metadata?.activityKind);
    const toolName = safeText(actionMetadata.toolName ?? metadata?.toolName, "Tool");
    const inputLabel = safeOptionalText(actionMetadata.inputLabel ?? metadata?.inputLabel);
    const label = safeText(actionMetadata.safeLabel ?? metadata?.safeLabel, inputLabel ? `${toolName}: ${inputLabel}` : toolName);
    return {
      id: `progress-${randomUUID()}`,
      kind: activityKind,
      state: "running",
      safe_label: label,
      safe_tool_name: toolName,
      safe_input_label: inputLabel,
      tool_call_id: safeOptionalText(actionMetadata.toolCallId ?? metadata?.toolCallId),
      work_block_id: safeOptionalText(actionMetadata.workBlockId ?? metadata?.workBlockId),
      work_block_label: safeOptionalText(actionMetadata.workBlockLabel ?? metadata?.workBlockLabel),
      work_decision_summary: safeOptionalText(actionMetadata.decisionSummary ?? metadata?.decisionSummary),
      work_decision_rationale: safeOptionalText(actionMetadata.decisionRationale ?? metadata?.decisionRationale),
      work_decision_next_step: safeOptionalText(actionMetadata.decisionNextStep ?? metadata?.decisionNextStep),
      work_decision_source: safeOptionalText(actionMetadata.decisionSource ?? metadata?.decisionSource),
      work_decision_evidence_refs: safeStringArray(actionMetadata.decisionEvidenceRefs ?? metadata?.decisionEvidenceRefs),
      safe_detail_rows: safeDetailRows(actionMetadata.detailRows ?? metadata?.detailRows),
    };
  }
  const tool = safeOptionalText(metadata?.tool ?? actionMetadata.tool);
  const phase = safeOptionalText(metadata?.phase ?? actionMetadata.phase);
  if (tool && phase === "before_tool_execution") {
    const text = safeOptionalText(action.message.text);
    return {
      id: `progress-${randomUUID()}`,
      kind: "dispatch",
      state: "running",
      safe_label: text ? `Dispatch: ${text}` : "Dispatching worker",
      safe_tool_name: "Dispatch",
      safe_input_label: text,
      safe_detail_rows: [
        {
          id: "dispatch-tool",
          kind: "tool",
          safe_label: "Tool",
          safe_value: tool,
          state: "running",
        },
      ],
    };
  }
  return null;
}

function safeProgressState(value: unknown): ProgressRowInput["state"] {
  const text = safeOptionalText(value);
  if (
    text === "accepted" ||
    text === "running" ||
    text === "delivered" ||
    text === "failed" ||
    text === "cancelled"
  ) {
    return text;
  }
  return "running";
}

function safeProgressKind(value: unknown): ProgressRowInput["kind"] {
  const text = safeOptionalText(value);
  if (
    text === "searched" ||
    text === "read" ||
    text === "ran_command" ||
    text === "edited" ||
    text === "dispatch" ||
    text === "used_tool"
  ) {
    return text;
  }
  return "used_tool";
}

function safeDetailRows(value: unknown): ProgressRowInput["safe_detail_rows"] {
  if (!Array.isArray(value)) return undefined;
  const rows = value
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null && !Array.isArray(row))
    .map((row, index) => ({
      id: safeText(row.id, `detail-${index + 1}`),
      kind: safeOptionalText(row.kind),
      safe_label: safeText(row.safe_label, "Detail"),
      safe_value: safeOptionalText(row.safe_value),
      state: safeOptionalText(row.state) ?? "running",
    }))
    .slice(0, 12);
  return rows.length > 0 ? rows : undefined;
}

function safeTodoPhase(value: unknown): string | null {
  if (
    value === "conception" ||
    value === "planning" ||
    value === "execution" ||
    value === "review" ||
    value === "consolidation" ||
    value === "reporting"
  ) {
    return value;
  }
  return null;
}

function todoPhaseLabel(value: string): string {
  if (value === "conception") return "구상";
  if (value === "planning") return "계획";
  if (value === "execution") return "실행";
  if (value === "review") return "검토";
  if (value === "consolidation") return "취합 및 정리";
  if (value === "reporting") return "보고";
  return value;
}

function safeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value
    .map((item) => safeOptionalText(item))
    .filter((item): item is string => Boolean(item))
    .slice(0, 6);
  return rows.length > 0 ? rows : undefined;
}

function safeText(value: unknown, fallback: string): string {
  return safeOptionalText(value) ?? fallback;
}

function safeOptionalNumber(value: unknown): number | undefined {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return undefined;
  return Math.floor(numberValue);
}

function safeOptionalText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : "";
  const normalized = stripControlCharacters(text)
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/giu, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized ? normalized.slice(0, 180) : undefined;
}

function safeOptionalLocalPath(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : "";
  const normalized = stripControlCharacters(text).trim();
  return normalized || undefined;
}

function stripControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
}

function sessionIdForChat(chatId: string): string {
  if (chatId === "general") return APP_SESSION_ID;
  return `butler/app-${safeSessionSegment(chatId)}`;
}

function safeSessionSegment(value: string): string {
  const normalized = value.trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9._-]+/gu, "-");
  return normalized || "session";
}

function defaultProvider(): ModelProviderAdapter {
  return {
    id: "openai",
    capabilities: {
      supportsStreaming: false,
      supportsToolCalls: false,
      supportsImages: false,
      supportsAudio: false,
      supportsServerThreads: false,
      supportsReasoningConfig: true,
      supportsPromptCaching: true,
    },
    async invoke(input) {
      const prompt = input.messages
        .map((message) => `${message.role}: ${message.content}`)
        .join("\n\n");
      const text = await runPromptText({
        prompt,
        model: input.model,
        instructions: input.systemPrompt,
        cacheScope: "app-gateway-provider",
      });
      return { text };
    },
  };
}

function policyStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim())
    : [];
}

const APP_BRIDGE_WORKSPACE_REQUIRED_TOOL_NAMES = new Set([
  "run_command",
  "read_tool_output_artifact",
]);

function bridgeRequiredToolsForAccessMode(
  value: unknown,
  accessMode: AppMessageResponderInput["accessMode"],
): string[] {
  const names = policyStringArray(value);
  return accessMode === "full_access"
    ? names
    : names.filter((name) => !APP_BRIDGE_WORKSPACE_REQUIRED_TOOL_NAMES.has(name));
}

function appBridgeRuntimePolicy(input: {
  existing?: Record<string, unknown>;
  accessMode?: AppMessageResponderInput["accessMode"];
}): Record<string, unknown> | undefined {
  const accessMode = input.accessMode ?? "full_access";
  const existing = input.existing ?? {};
  const requestedProfiles = policyStringArray(existing.requiredNativeToolProfiles)
    .filter((profile) => profile !== "workspace");
  if (accessMode === "full_access") requestedProfiles.push("workspace");
  return {
    ...existing,
    accessMode,
    requiredNativeTools: bridgeRequiredToolsForAccessMode(existing.requiredNativeTools, accessMode),
    required_tools: bridgeRequiredToolsForAccessMode(existing.required_tools, accessMode),
    requiredNativeToolProfiles: [...new Set(requestedProfiles)],
  };
}

function readButlerConfig(butlerData: string): ButlerConfig {
  const path = join(butlerData, "butler.config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ButlerConfig;
  } catch {
    return {};
  }
}

function parseUpdateCommand(text: string | undefined): "check" | "apply" | null {
  const trimmed = text?.trim();
  if (trimmed === "/update" || trimmed === "/update check") return "check";
  if (trimmed === "/update apply") return "apply";
  return null;
}

function dedupeTexts(texts: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const text of texts) {
    const trimmed = text.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}
