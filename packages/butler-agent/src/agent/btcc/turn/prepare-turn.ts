import { createHash } from "node:crypto";
import {
  ConversationAdmissionTurn,
  type ConversationContextStoreReader,
  type ConversationWriter,
} from "../../conversation/index.ts";
import type { ContextAssembly, PromptAssembler } from "../../prompt/prompt-assembler.ts";
import type { AttachmentRef } from "../../../gateways/core/contracts.ts";
import type { StoredSessionBinding } from "../../../test-support/harness/contracts.ts";
import type { SessionBindingStore } from "../../../test-support/harness/session-store.ts";
import {
  verifyTurnExecutionControls,
  type TurnAccessMode,
} from "../../../gateways/core/turn-execution-controls.ts";
import { resolveModelMetadata } from "../../../integrations/providers/model-catalog.ts";
import { modelApiRetryAttempts } from "../../../integrations/providers/shared/environment.ts";
import {
  snapshotContextDocuments,
  type BtccContextDocumentWriter,
} from "./context-documents.ts";
import type {
  AdmittedModelSelection,
  ButlerContextInput,
  BtccPreparedTurn,
  BtccRunCommand,
  BtccTurnRequest,
  ReasoningEffort,
  BtccTurnPreparation as BtccTurnPreparationPort,
} from "../contracts.ts";
import type { TurnStateRepository } from "./contracts.ts";
import { assertStableRequestIdentity } from "./load-or-admit-turn.ts";
import {
  commandFor,
  inboundEnvelopeFor,
  replayBinding,
  requestIdentityForRequest,
} from "./prepare-turn-request.ts";
import { includeRecentContext } from "./recent-conversation-context.ts";
import { buildModelRoute } from "../model-route/index.ts";

export type BtccTurnPreparationDependencies = {
  bindingStore: Pick<SessionBindingStore, "getBySessionId">;
  conversationStore: ConversationWriter & ConversationContextStoreReader;
  butlerData: string;
  promptAssembler: Pick<PromptAssembler, "buildButlerContextAssembly">;
  contextDocuments: BtccContextDocumentWriter;
  turns: Pick<TurnStateRepository, "findTurn">;
  wakeAuthorizations: import("./contracts.ts").BtccWakeAuthorizationReader;
};

export class DefaultBtccTurnPreparation implements BtccTurnPreparationPort {
  constructor(private readonly dependencies: BtccTurnPreparationDependencies) {}

  async prepare(request: BtccTurnRequest): Promise<BtccPreparedTurn> {
    const existingTurn = await this.dependencies.turns.findTurn(request.turnId).catch(() => null);
    if (existingTurn) {
      assertStableRequestIdentity(existingTurn, requestIdentityForRequest(request));
      return this.prepareConversationProjection(
        request,
        replayBinding(existingTurn, request),
        { kind: "resume", turnId: request.turnId, recoveryAttempt: request.recoveryAttempt },
        false,
      );
    }

    if (request.trigger.kind === "authorized_wake") {
      const authorized = await this.dependencies.wakeAuthorizations.validateWake({
        sourceTurnId: request.trigger.sourceTurnId,
        authorizationRef: request.trigger.authorizationRef,
        ...(request.trigger.resultScopeRef
          ? { resultScopeRef: request.trigger.resultScopeRef }
          : {}),
      });
      if (!authorized) {
        throw new Error("BTCC authorized wake denied");
      }
    }

    const binding = this.dependencies.bindingStore.getBySessionId(request.sessionId);
    if (!binding) {
      throw new Error(`Missing stored BTCC session binding: ${request.sessionId}`);
    }
    if (binding.role !== request.route.role) {
      throw new Error(
        `Stored session ${request.sessionId} has role ${binding.role}, expected ${request.route.role}`,
      );
    }
    const envelope = inboundEnvelopeFor(request);

    const assembly = includeRecentContext(
      this.dependencies.conversationStore,
      binding,
      envelope,
      this.dependencies.promptAssembler.buildButlerContextAssembly({
        binding,
        envelope,
        route: {
          sessionId: request.sessionId,
          role: request.route.role,
          reason: request.route.reason ?? "transport-binding",
          workspacePath: request.route.workspacePath,
          ...(request.route.projectId ? { projectId: request.route.projectId } : {}),
        },
      }),
    );
    const controls = request.executionControls
      ? verifyTurnExecutionControls(request.executionControls)
      : undefined;
    const context = snapshotTurnContext({
      binding,
      assembly,
      documents: this.dependencies.contextDocuments,
      attachments: request.message.attachments,
      imageAdmission: request.message.imageAdmission,
      authorityRequestRef: request.appTurnContext?.authorityRequestRef,
      authorityClientMessageId: request.appTurnContext?.authorityClientMessageId,
      turnAccessMode: controls?.access_mode,
    });
    const modelSelection = admitModel(binding, controls);
    const command = commandFor(request, modelSelection, context);

    return this.prepareConversationProjection(request, binding, command, true);
  }

  private prepareConversationProjection(
    request: BtccTurnRequest,
    binding: StoredSessionBinding,
    command: BtccRunCommand,
    isFresh: boolean,
  ): BtccPreparedTurn {
    const envelope = inboundEnvelopeFor(request);
    const conversation = ConversationAdmissionTurn.begin({
      writer: this.dependencies.conversationStore,
      binding,
      envelope,
      turnId: request.turnId,
      timestamp: request.message.timestamp,
      butlerData: this.dependencies.butlerData,
    });
    conversation.admitInbound();

    return {
      command,
      isFresh,
      recordEvent: (event) => conversation.admitTurnEvent(event),
      complete: (outcome) => {
        if (this.dependencies.conversationStore.readTurnOutcome?.(request.turnId)?.outcome === "delivered") {
          return;
        }
        conversation.admitFinalAssistant(
          outcome.content,
          `btcc-canonical-final:${outcome.messageId}`,
        );
        conversation.finalize("complete", new Date().toISOString());
      },
      cancel: () => {
        if (this.dependencies.conversationStore.readTurnOutcome?.(request.turnId)?.outcome === "cancelled") {
          return;
        }
        conversation.finalize("aborted", new Date().toISOString());
      },
    };
  }
}

export function snapshotTurnContext(input: {
  binding: StoredSessionBinding;
  assembly: ContextAssembly;
  documents: BtccContextDocumentWriter;
  attachments?: AttachmentRef[];
  imageAdmission?: import("../../image-attachment/contracts.ts").VisualImageAdmissionResult;
  authorityRequestRef?: string;
  authorityClientMessageId?: string;
  turnAccessMode?: TurnAccessMode;
}): ButlerContextInput {
  const sections = [
    ...input.assembly.staticContext,
    ...input.assembly.liveConfiguration,
    ...input.assembly.runtimeState,
    ...input.assembly.workingContext,
    ...input.assembly.retrievedContext,
  ];
  const userRef = principalRef(input.binding);
  const snapshot = snapshotContextDocuments({
    userRef,
    sessionId: input.binding.sessionId,
    ...(input.binding.projectId ? { projectRef: input.binding.projectId } : {}),
    workspacePath: input.binding.workspacePath,
    sections: sections.map((section) => ({
      id: section.id,
      content: `## ${section.title}\n\n${section.content}`,
      sourceRevision: digest({
        id: section.id,
        content: section.content,
        projectionClass: section.projectionClass,
        scopeKind: section.scopeKind,
      }),
      projectionClass: section.projectionClass,
      scopeKind: section.scopeKind,
    })),
  }, input.documents);
  return {
    ...snapshot,
    executionPolicy: {
      role: input.binding.role,
      accessMode: input.turnAccessMode ?? accessMode(
        input.binding.metadata?.runtimePolicy && record(input.binding.metadata.runtimePolicy).accessMode
          ? record(input.binding.metadata.runtimePolicy).accessMode
          : input.binding.metadata?.accessMode,
      ),
      trackingMode: trackingMode(input.binding),
      requiredNativeToolProfiles: uniqueStrings([
        ...stringArray(input.binding.metadata?.requiredNativeToolProfiles),
        ...stringArray(record(input.binding.metadata?.runtimePolicy).requiredNativeToolProfiles),
      ]),
      requiredNativeTools: uniqueStrings([
        ...stringArray(input.binding.metadata?.requiredNativeTools),
        ...stringArray(input.binding.metadata?.required_tools),
        ...stringArray(record(input.binding.metadata?.runtimePolicy).requiredNativeTools),
        ...stringArray(record(input.binding.metadata?.runtimePolicy).required_tools),
      ]),
      workspacePath: input.binding.workspacePath,
      ...(input.binding.projectId ? { projectId: input.binding.projectId } : {}),
    },
    ...(input.authorityRequestRef ? { authorityRequestRef: input.authorityRequestRef } : {}),
    ...(input.authorityClientMessageId ? { authorityClientMessageId: input.authorityClientMessageId } : {}),
    ...(input.attachments?.length
      ? { attachments: input.attachments.map((attachment) => ({
          id: attachment.id,
          kind: attachment.kind,
          ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
          ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
          ...(Number.isFinite(attachment.sizeBytes) ? { sizeBytes: attachment.sizeBytes } : {}),
          ...(attachment.url ? { url: attachment.url } : {}),
          ...(attachment.kind !== "image" && attachment.localPath
            ? { localPath: attachment.localPath }
            : {}),
          ...(attachment.visualManifest ? { visualManifest: attachment.visualManifest } : {}),
        })) }
      : {}),
    ...(input.imageAdmission ? { imageAdmission: input.imageAdmission } : {}),
  };
}

function admitModel(
  binding: StoredSessionBinding,
  controls?: ReturnType<typeof verifyTurnExecutionControls>,
): AdmittedModelSelection {
  const modelRef = requiredText(
    controls?.model_ref ?? binding.modelRef,
    "BTCC admitted model",
  );
  const separator = modelRef.indexOf("/");
  if (separator <= 0 || separator === modelRef.length - 1) {
    throw new Error(`BTCC admitted model is not canonical: ${modelRef}`);
  }
  const reasoningEffort = controls?.reasoning_effort
    ?? String(binding.metadata?.reasoning_effort ?? "medium");
  if (!isReasoningEffort(reasoningEffort)) {
    throw new Error(`BTCC admitted reasoning effort is invalid: ${reasoningEffort}`);
  }
  const admittedControls: Record<string, string | number | boolean> = controls
    ? {
        accessMode: controls.access_mode,
        planMode: controls.plan_mode,
        source: controls.source,
        sessionControlRevision: controls.session_control_revision,
        catalogGeneration: controls.catalog_generation,
      }
    : {
        accessMode: String(binding.metadata?.accessMode ?? "full_access"),
        planMode: Boolean(binding.metadata?.plan_mode),
        source: "stored_session_binding",
      };
  return {
    provider: modelRef.slice(0, separator),
    model: modelRef.slice(separator + 1),
    reasoningEffort,
    controls: admittedControls,
    controlsHash: controls?.integrity_hash ?? digest(admittedControls),
    contextWindowTokens: admittedContextWindow(binding, modelRef),
    modelRoute: buildModelRoute({
      primaryModelRef: modelRef,
      backupModelRefs: controls?.model_fallback?.enabled
        ? controls.model_fallback.models
        : [],
      reasoningEffort,
      catalogGeneration: controls?.catalog_generation,
      retryCeiling: modelApiRetryAttempts(),
    }),
  };
}

function admittedContextWindow(binding: StoredSessionBinding, modelRef: string): number {
  const configured = binding.metadata?.context_window_tokens;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.trunc(configured);
  }
  return resolveModelMetadata(modelRef).context_window_tokens ?? 200_000;
}

function accessMode(value: unknown): TurnAccessMode {
  if (value === "full_access" || value === "ask_first" || value === "read_only") return value;
  return "read_only";
}

function trackingMode(binding: StoredSessionBinding): "ledger" | "local" | "none" {
  const value = record(binding.metadata?.runtimePolicy).trackingMode ??
    record(binding.metadata?.runtimePolicy).tracking_mode;
  if (value === "ledger" || value === "local" || value === "none") return value;
  return binding.projectId ? "ledger" : "local";
}

function principalRef(binding: StoredSessionBinding): string {
  const configured = binding.metadata?.userRef;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : "local-principal";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim())
    : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing`);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return ["none", "low", "medium", "high", "xhigh", "max"].includes(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
