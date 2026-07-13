import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import type {
  AgentRuntimeAdapter,
  InboundEnvelope,
  ModelProviderAdapter,
  RuntimeSessionHandle,
  RuntimeTurnEventInput,
  StoredSessionBinding,
  ToolDefinition,
  OutboundAction,
  ArtifactRef,
} from "../../test-support/harness/contracts.ts";
import type { RuntimeDeliveryClassification } from "../../agent/turn/runtime-delivery-state.ts";
import {
  TURN_ACKNOWLEDGED_EVENT_KIND,
  TURN_DECISION_EVENT_KIND,
  createTurnAcknowledgedPayload,
} from "../../agent/events/turn-state-contract.ts";
import {
  FIRST_VISIBLE_PROGRESS_GATEWAY_NOTE,
  FIRST_VISIBLE_PROGRESS_GATEWAY_SOURCE,
  firstVisibleProgressPayload,
} from "../../agent/events/first-visible-progress.ts";
import { generateOpeningDecisionWithProvider } from "../../agent/output/opening-decision.ts";
import {
  recordDurableInbound,
  recordDurableOutbound,
  recordSessionLifecycle,
  recordSystemEvent,
} from "../../test-support/harness/durable-session-transcript.ts";
import { SessionBindingStore } from "../../test-support/harness/session-store.ts";
import {
  diagnosticDetails,
  isAdmissionInvariantViolation,
  safeRuntimeFailure,
} from "../../integrations/providers/provider-errors.ts";
import { bindProviderToModel } from "../../integrations/providers/registry.ts";
import { INTERNAL_RECOVERY_REQUIRED_CODE } from "../../runtime/internal-recovery-failure.ts";
import {
  isNonPublicContinuationDeliveryError,
  isPromptUsageModelCallBudgetError,
} from "../../agent/turn/recoverable-delivery.ts";
import {
  clearTurnContextAtom,
  isTurnSchedulerContinuationYieldError,
} from "../../agent/turn/turn-continuation-context.ts";
import type {
  GatewayActorTurnResult,
  GatewayDurableRole,
  GatewayRoute,
  GatewaySessionActor,
} from "../../gateways/core/contracts.ts";
import { APP_TRANSPORT } from "../../gateways/core/app-transport.ts";
import { ConversationAdmissionTurn } from "../../agent/conversation/session-admission.ts";
import { INTERNAL_CONVERSATION_TURN_EVENT_KINDS } from "../../agent/conversation/admission-kinds.ts";
import type { ConversationWriter } from "../../agent/conversation/types.ts";
import type { ContextAssembly } from "../../agent/prompt/prompt-assembler.ts";
import type {
  DeveloperLogCaptureInput,
} from "../../operations/diagnostics/developer-log-store.ts";

interface SessionActorOptions {
  sessionId: string;
  role: GatewayDurableRole;
  store: SessionBindingStore;
  runtime: AgentRuntimeAdapter;
  provider: ModelProviderAdapter;
  systemPrompt: string;
  tools?: ToolDefinition[];
  buildTurnContext?: (input: {
    binding: StoredSessionBinding;
    envelope: InboundEnvelope;
    route?: GatewayRoute;
  }) => string | {
    promptContext?: string;
    contextAssembly?: ContextAssembly;
  } | undefined;
  captureDeveloperModelTurn?: (input: DeveloperLogCaptureInput) => void;
  deliverIntermediate?: (input: {
    binding: StoredSessionBinding;
    envelope: InboundEnvelope;
    route?: GatewayRoute;
    action: OutboundAction;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  deliverTurnEvent?: (input: {
    binding: StoredSessionBinding;
    envelope: InboundEnvelope;
    route?: GatewayRoute;
    event: RuntimeTurnEventInput;
  }) => Promise<void>;
  generateSessionTitle?: (input: {
    binding: StoredSessionBinding;
    envelope: InboundEnvelope;
    route?: GatewayRoute;
  }) => Promise<string | null>;
  conversationWriter?: ConversationWriter;
  conversationMetricsButlerData?: string;
  openingDecisionTimeoutMs?: number;
  now?: () => string;
}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === "string" ? error : "Unknown runtime error");
}

function defaultNow(): string {
  return new Date().toISOString();
}

const DEFAULT_TYPING_INTERVAL_MS = 4_000;
const EMPTY_FINAL_DURABLE_TEXT = "[turn completed without public final text]";
const DEFAULT_OPENING_DECISION_TIMEOUT_MS = 0;

type StewardActivityTimelineEvent = {
  schema: "butler.steward-activity-event.v1";
  event_id: string;
  created_at: string;
  actor: "steward";
  session_id: string;
  turn_id: string;
  event: "turn_received" | "activity_updated" | "turn_finished" | "turn_failed";
  semantic_phase:
    | "orienting"
    | "planning"
    | "inspecting"
    | "executing"
    | "verifying"
    | "consolidating"
    | "reporting"
    | "blocked";
  action_kind:
    | "receive_message"
    | "run_agent"
    | "write_transcript"
    | "report"
    | "error";
  status: "started" | "completed" | "failed";
  decision_summary: string;
  decision_rationale: string;
  decision_next_step: string;
  evidence_refs?: string[];
};

type StewardActivityProjection = {
  schema: "butler.steward-activity.v1";
  session_id: string;
  turn_id: string;
  updated_at: string;
  current_event: StewardActivityTimelineEvent["event"];
  semantic_phase: StewardActivityTimelineEvent["semantic_phase"];
  action_kind: StewardActivityTimelineEvent["action_kind"];
  status: StewardActivityTimelineEvent["status"];
  decision_summary: string;
  decision_next_step: string;
};

function safeSessionPathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.=-]+/g, "_").slice(0, 180) || "session";
}

function stewardTimelineRoot(sessionId: string): string {
  const dataRoot =
    process.env.BUTLER_DATA ||
    join(process.env.HOME || process.cwd(), ".butler");
  return join(dataRoot, "steward-activity", safeSessionPathSegment(sessionId));
}

function gatewayMetricsButlerData(): string {
  return process.env.BUTLER_DATA || join(process.env.HOME || process.cwd(), ".butler");
}

function stewardEventId(
  event: StewardActivityTimelineEvent["event"],
  turnId: string,
): string {
  return `${Date.now().toString(36)}-${event}-${safeSessionPathSegment(turnId).slice(0, 40)}-${Math.random().toString(36).slice(2, 8)}`;
}

function appendStewardActivityTimelineEvent(
  input: Omit<
    StewardActivityTimelineEvent,
    "schema" | "event_id" | "created_at" | "actor"
  >,
): void {
  try {
    const root = stewardTimelineRoot(input.session_id);
    mkdirSync(root, { recursive: true });
    const event: StewardActivityTimelineEvent = {
      schema: "butler.steward-activity-event.v1",
      event_id: stewardEventId(input.event, input.turn_id),
      created_at: defaultNow(),
      actor: "steward",
      ...input,
    };
    appendFileSync(
      join(root, "steward_activity_events.jsonl"),
      `${JSON.stringify(event)}\n`,
      "utf8",
    );
    const projection: StewardActivityProjection = {
      schema: "butler.steward-activity.v1",
      session_id: event.session_id,
      turn_id: event.turn_id,
      updated_at: event.created_at,
      current_event: event.event,
      semantic_phase: event.semantic_phase,
      action_kind: event.action_kind,
      status: event.status,
      decision_summary: event.decision_summary,
      decision_next_step: event.decision_next_step,
    };
    writeFileSync(
      join(root, "steward_activity.json"),
      `${JSON.stringify(projection, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // Timeline observability must never break the principal-facing turn path.
  }
}

function peerKindFromEnvelope(
  peer: InboundEnvelope["peer"],
): OutboundAction["peer"]["kind"] {
  return peer.kind;
}

function turnIdFromEnvelope(envelope: InboundEnvelope): string {
  return (
    envelope.routingHints?.turnId?.trim() ||
    envelope.eventId.replace(/[^A-Za-z0-9._:-]/g, "_")
  );
}

function liveConfigHashFromPromptContext(
  promptContext?: string,
): string | null {
  const match = promptContext?.match(
    /^Live Configuration Hash:\s*([A-Za-z0-9_-]+)/mu,
  );
  return match?.[1] ?? null;
}

function loadedSkillNamesFromPromptContext(promptContext?: string): string[] {
  const match = promptContext?.match(
    /(?:^|\n)## Skill Catalog\n\n([\s\S]*?)(?:\n\n---\n\n## |$)/u,
  );
  if (!match?.[1]) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const line of match[1].split("\n")) {
    const item = line.match(/^\s*-\s+([\w:./-]+):/u);
    const name = item?.[1]?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.slice(0, 48);
}

function outboundArtifacts(
  artifacts?: ArtifactRef[],
): ArtifactRef[] | undefined {
  const safeArtifacts = artifacts?.map((artifact) => ({
    id: safeArtifactText(artifact.id, "artifact"),
    kind: artifact.kind,
    title: safeArtifactText(artifact.title, "Artifact"),
    safePathLabel: safeArtifactLabel(artifact.safePathLabel),
    mimeType: artifact.mimeType,
    url: artifact.url,
    sizeBytes: artifact.sizeBytes,
    createdAt: artifact.createdAt,
  }));
  return safeArtifacts && safeArtifacts.length > 0 ? safeArtifacts : undefined;
}

function actionWithTurnIdentity(
  action: OutboundAction,
  binding: StoredSessionBinding,
  envelope: InboundEnvelope,
): OutboundAction {
  return {
    ...action,
    metadata: {
      ...(action.metadata ?? {}),
      sessionId: action.metadata?.sessionId ?? binding.sessionId,
      turnId: action.metadata?.turnId ?? turnIdFromEnvelope(envelope),
      sourceEventId: action.metadata?.sourceEventId ?? envelope.eventId,
    },
  };
}

function safeArtifactText(value: string | undefined, fallback: string): string {
  const text = stripControlCharacters(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  return (text || fallback).slice(0, 180);
}

function safeArtifactLabel(value: string | undefined): string | undefined {
  const label = stripControlCharacters(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!label) return undefined;
  const normalized = label.replace(/\\/gu, "/");
  const hasParentSegment = normalized.split("/").includes("..");
  const pathLike =
    isAbsolute(label) || /^[A-Za-z]:\//u.test(normalized) || hasParentSegment;
  return (pathLike ? basename(normalized) : label).slice(0, 180);
}

function stripControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
}

function dispatchClaimIdFromEnvelope(envelope: InboundEnvelope): string | undefined {
  const raw = envelope.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = (raw as Record<string, unknown>).dispatchClaimId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function queueIdFromEnvelope(envelope: InboundEnvelope): string | undefined {
  const raw = envelope.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = (raw as Record<string, unknown>).queueId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finalResultAction(input: {
  binding: StoredSessionBinding;
  envelope: InboundEnvelope;
  text: string;
  artifacts?: ArtifactRef[];
  delivery?: RuntimeDeliveryClassification;
  generatedSessionTitle?: string | null;
  loadedSkillNames?: string[];
}): OutboundAction {
  const threadId =
    input.envelope.peer.kind === "thread"
      ? input.envelope.peer.id
      : input.envelope.peer.parentId;
  const peerId =
    input.envelope.peer.kind === "thread" && input.envelope.peer.parentId
      ? input.envelope.peer.parentId
      : input.envelope.peer.id;
  return {
    actionId: `runtime-final:${turnIdFromEnvelope(input.envelope)}`,
    transport: input.envelope.transport,
    accountId: input.envelope.accountId,
    peer: {
      kind: peerKindFromEnvelope(input.envelope.peer),
      id: peerId,
      threadId,
    },
    message: {
      text: input.text.trim() ? input.text : EMPTY_FINAL_DURABLE_TEXT,
      artifacts: outboundArtifacts(input.artifacts),
      replyToMessageId: input.envelope.message.id,
    },
    metadata: {
      source: "gateway-actor",
      kind: "final_result",
      turnId: turnIdFromEnvelope(input.envelope),
      sessionId: input.binding.sessionId,
      queueId: queueIdFromEnvelope(input.envelope),
      dispatchClaimId: dispatchClaimIdFromEnvelope(input.envelope),
      emptyFinal: !input.text.trim(),
      delivery_state: input.delivery?.delivery_state,
      limitation_codes: input.delivery?.limitation_codes,
      limitations: input.delivery?.limitations,
      generatedSessionTitle: input.generatedSessionTitle ?? undefined,
      loadedSkillNames: input.loadedSkillNames ?? [],
    },
  };
}

export abstract class BaseGatewaySessionActor implements GatewaySessionActor {
  private handle: RuntimeSessionHandle | null = null;
  private turnQueue: Promise<void> = Promise.resolve();
  private liveConfigHash: string | null = null;

  readonly sessionId: string;
  readonly role: GatewayDurableRole;

  protected constructor(private readonly options: SessionActorOptions) {
    this.sessionId = options.sessionId;
    this.role = options.role;
  }

  async handleInbound(
    envelope: InboundEnvelope,
    route?: GatewayRoute,
  ): Promise<GatewayActorTurnResult> {
    return await this.enqueueTurn(() => this.handleInboundNow(envelope, route));
  }

  async close(reason = "gateway-close"): Promise<void> {
    await this.enqueueTurn(() => this.closeNow(reason));
  }

  private async enqueueTurn<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.turnQueue.then(operation, operation);
    this.turnQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  private async handleInboundNow(
    envelope: InboundEnvelope,
    route?: GatewayRoute,
  ): Promise<GatewayActorTurnResult> {
    const turnId = turnIdFromEnvelope(envelope);
    if (this.role === "steward") {
      appendStewardActivityTimelineEvent({
        session_id: this.options.sessionId,
        turn_id: turnId,
        event: "turn_received",
        semantic_phase: "orienting",
        action_kind: "receive_message",
        status: "started",
        decision_summary: "Steward received a project/workstream turn.",
        decision_rationale:
          "Steward turns need the same durable work-intent history as Butler-facing work blocks.",
        decision_next_step:
          "Persist the inbound transcript event, then run the steward session agent.",
      });
    }
    const binding = this.requireBinding();
    const timestamp =
      envelope.message.timestamp || this.options.now?.() || defaultNow();
    const schedulerContinuation = schedulerContinuationMetadata(envelope);
    let conversationAdmission: ConversationAdmissionTurn | null = null;
    let openingDecisionId: string | undefined;
    let promptContext: string | undefined;
    let contextAssembly: ContextAssembly | undefined;
    let developerLogBinding = binding;

    try {
      const admitsSemanticConversation = this.shouldAdmitSemanticConversation(envelope);
      let acceptedFirstProgressEmitted = false;
      if (!schedulerContinuation) {
        recordDurableInbound({
          sessionId: binding.sessionId,
          envelope,
          route: route
            ? {
                sessionId: route.sessionId,
                role: route.role,
                reason: route.reason,
                projectId: route.projectId ?? null,
              }
            : undefined,
          metadata: {
            source: "gateway-actor",
          },
          timestamp,
        });
      }
      if (admitsSemanticConversation) {
        conversationAdmission = this.beginConversationAdmissionTurn({
          binding,
          envelope,
          turnId,
          timestamp,
        });
        if (!schedulerContinuation) conversationAdmission?.admitInbound();
      }

      if (!schedulerContinuation) {
        const acknowledged = await this.emitTurnAcknowledged({
          binding,
          envelope,
          route,
          timestamp,
        });
        if (acknowledged) {
          acceptedFirstProgressEmitted = await this.emitAcceptedFirstProgress({
            binding,
            envelope,
            route,
            timestamp,
          });
          openingDecisionId = await this.emitOpeningDecision({
            binding,
            envelope,
            route,
            timestamp,
          });
        }
      }
      const turnContext = this.options.buildTurnContext?.({
        binding,
        envelope,
        route,
      });
      promptContext =
        typeof turnContext === "string"
          ? turnContext
          : turnContext?.promptContext;
      contextAssembly =
        typeof turnContext === "string"
          ? undefined
          : turnContext?.contextAssembly;
      const loadedSkillNames = loadedSkillNamesFromPromptContext(promptContext);
      recordSystemEvent({
        sessionId: binding.sessionId,
        category: "context.skills.loaded",
        details: {
          turnId: turnIdFromEnvelope(envelope),
          skillNames: loadedSkillNames,
        },
        metadata: {
          source: "gateway-actor",
          turnId: turnIdFromEnvelope(envelope),
        },
        timestamp,
      });
      await this.invalidateRuntimeHandleIfLiveConfigChanged(
        binding,
        timestamp,
        promptContext,
      );
      const activeBinding = this.requireBinding();
      developerLogBinding = activeBinding;
      const generatedSessionTitlePromise = schedulerContinuation
        ? Promise.resolve(null)
        : this.generateSessionTitleBestEffort(activeBinding, envelope, route);
      const handle = await this.ensureRuntimeHandle(activeBinding, timestamp);
      const emitIntermediate = this.options.deliverIntermediate
        ? async (
            action: OutboundAction,
            metadata?: Record<string, unknown>,
          ) => {
            await this.options.deliverIntermediate?.({
              binding: activeBinding,
              envelope,
              route,
              action: actionWithTurnIdentity(action, activeBinding, envelope),
              metadata,
            });
          }
        : undefined;
      const emitTurnEvent = this.options.deliverTurnEvent || conversationAdmission
        ? async (event: RuntimeTurnEventInput) => {
            conversationAdmission?.admitTurnEvent(event);
            if (event.visibility === "internal" || INTERNAL_CONVERSATION_TURN_EVENT_KINDS.has(event.kind)) return;
            await this.options.deliverTurnEvent?.({
              binding: activeBinding,
              envelope,
              route,
              event,
            });
          }
        : undefined;
      const stopPresence = this.startTypingPresence({
        binding: activeBinding,
        envelope,
        emitIntermediate,
      });
      const turnProvider = bindProviderToModel(this.options.provider, binding.modelRef);
      let result;
      try {
        result = await this.options.runtime.runTurn({
          handle,
          provider: turnProvider,
          model: binding.modelRef,
          input: envelope,
          signal: envelope.signal,
          metadata: {
            sessionId: activeBinding.sessionId,
            role: activeBinding.role,
            projectId: activeBinding.projectId ?? null,
            source: "gateway-actor",
            currentUserText: envelope.message.text?.trim() ?? "",
            promptContext,
            turnId: turnIdFromEnvelope(envelope),
            gatewayFirstVisibleProgressEmitted: acceptedFirstProgressEmitted,
            openingDecisionId,
            schedulerContinuation: schedulerContinuation
              ? {
                contextAtomId: schedulerContinuation.contextAtomId,
                continuationForQueueId: schedulerContinuation.continuationForQueueId,
                checkpointId: schedulerContinuation.checkpointId,
                schedulerItemId: schedulerContinuation.schedulerItemId,
              }
              : undefined,
            runtimePolicy: activeBinding.metadata?.runtimePolicy,
            workerModelRules: activeBinding.metadata?.workerModelRules,
            reasoning_effort: activeBinding.metadata?.reasoning_effort,
            reasoningEffort: activeBinding.metadata?.reasoningEffort,
          },
          emitIntermediateDelivery: emitIntermediate,
          emitTurnEvent,
        });
      } finally {
        stopPresence();
      }

      const nextHandle: RuntimeSessionHandle = {
        ...handle,
        runtimeSessionRef: result.runtimeSessionRef ?? handle.runtimeSessionRef,
      };
      this.handle = nextHandle;
      this.persistBinding(activeBinding, {
        runtimeSessionRef: nextHandle.runtimeSessionRef,
        providerThreadRef:
          result.providerThreadRef ?? activeBinding.providerThreadRef,
        lifecycleState: "active",
        updatedAt: timestamp,
        lastActiveAt: timestamp,
      });

      for (const delivery of result.deliveries ?? []) {
        recordDurableOutbound({
          sessionId: activeBinding.sessionId,
          action: delivery,
          timestamp,
          metadata: {
            source: "gateway-actor",
          },
        });
      }
      if (turnId) {
        clearTurnContextAtom({
          butlerData: gatewayMetricsButlerData(),
          sessionId: activeBinding.sessionId,
          turnId,
        });
      }
      const generatedSessionTitle = await generatedSessionTitlePromise;
      const finalAction = finalResultAction({
        binding: activeBinding,
        envelope,
        text: result.text,
        artifacts: result.artifacts,
        delivery: result.delivery,
        generatedSessionTitle,
        loadedSkillNames,
      });
      recordDurableOutbound({
        sessionId: activeBinding.sessionId,
        action: finalAction,
        timestamp,
        metadata: {
          source: "gateway-actor#runtime-result",
          turnId: turnIdFromEnvelope(envelope),
        },
      });
      conversationAdmission?.admitFinalAssistant(result.text, finalAction.actionId);
      conversationAdmission?.finalize("complete", timestamp);
      this.captureDeveloperModelTurn({
        binding: activeBinding,
        envelope,
        route,
        contextAssembly,
        promptContext,
        result,
        timestamp,
        metadata: {
          source: "gateway-actor",
          openingDecisionId,
          schedulerContinuation: schedulerContinuation
            ? {
              contextAtomId: schedulerContinuation.contextAtomId,
              continuationForQueueId: schedulerContinuation.continuationForQueueId,
            }
            : undefined,
        },
      });

      return {
        text: result.text,
        deliveries: result.deliveries,
        artifacts: result.artifacts,
        delivery: result.delivery,
        generatedSessionTitle,
        loadedSkillNames,
        providerThreadRef: result.providerThreadRef,
        runtimeSessionRef: nextHandle.runtimeSessionRef,
        raw: result.raw,
      };
      } catch (error) {
      const err = asError(error);
      const safeFailure = safeRuntimeFailure(error);
      const isSchedulerYield = isTurnSchedulerContinuationYieldError(error);
      const isCancelled = envelope.signal?.aborted === true || err.name === "AbortError";
      const isContinuationFailure =
        safeFailure.code === INTERNAL_RECOVERY_REQUIRED_CODE ||
        isNonPublicContinuationDeliveryError(error) ||
        isPromptUsageModelCallBudgetError(error) ||
        isAdmissionInvariantViolation(error) ||
        isSchedulerYield;
      if (isCancelled) {
        try {
          conversationAdmission?.finalize("aborted", timestamp);
        } catch {
          recordSystemEvent({
            sessionId: this.sessionId,
            category: "conversation.admission.cancel_finalize_failed",
            message: safeFailure.message,
            metadata: { source: "gateway-actor" },
            timestamp,
          });
        }
      } else if (isContinuationFailure) {
        try {
          conversationAdmission?.finalizeRecoverable(
            timestamp,
            isSchedulerYield ? "turn_scheduler_continuation_yield" : safeFailure.code,
          );
        } catch {
          recordSystemEvent({
            sessionId: this.sessionId,
            category: "conversation.admission.recoverable_finalize_failed",
            message: safeFailure.message,
            metadata: { source: "gateway-actor" },
            timestamp,
          });
        }
      }
      if (!isContinuationFailure && !isCancelled) {
        this.finalizeConversationAdmissionFailure(conversationAdmission, timestamp, error);
      }
      this.captureDeveloperModelTurn({
        kind: "model_turn_error",
        binding: developerLogBinding,
        envelope,
        route,
        contextAssembly,
        promptContext,
        failure: safeFailure,
        diagnostics: diagnosticDetails(error),
        timestamp,
        metadata: {
          source: "gateway-actor",
          openingDecisionId,
          schedulerContinuation: schedulerContinuation
            ? {
              contextAtomId: schedulerContinuation.contextAtomId,
              continuationForQueueId: schedulerContinuation.continuationForQueueId,
            }
            : undefined,
        },
      });
      const failureState = isContinuationFailure
        ? "active"
        : "crashed";
      this.options.store.updateLifecycleState(binding.sessionId, failureState, timestamp);
      recordSessionLifecycle({
        sessionId: binding.sessionId,
        role: binding.role,
        state: failureState,
        reason: isSchedulerYield
          ? "gateway-turn-continuing"
          : failureState === "active"
          ? "gateway-turn-incomplete"
          : "gateway-runtime-error",
        metadata: isSchedulerYield
          ? {
            contextAtomId: error.contextAtomId,
            checkpointId: error.checkpointId,
          }
          : {
            message: safeFailure.message,
            code: safeFailure.code,
            diagnostics: diagnosticDetails(error),
          },
        timestamp,
      });
      if (!isSchedulerYield) {
        recordSystemEvent({
          sessionId: binding.sessionId,
          category: "runtime_error",
          message: safeFailure.message,
          statusCode: safeFailure.statusCode,
          details: diagnosticDetails(error),
          metadata: {
            source: "gateway-actor",
            code: safeFailure.code,
          },
          timestamp,
        });
      }
      throw err;
    }
  }

  private beginConversationAdmissionTurn(input: {
    binding: StoredSessionBinding;
    envelope: InboundEnvelope;
    turnId: string;
    timestamp: string;
  }): ConversationAdmissionTurn | null {
    if (!this.options.conversationWriter) return null;
    return ConversationAdmissionTurn.begin({
      writer: this.options.conversationWriter,
      binding: input.binding,
      envelope: input.envelope,
      turnId: input.turnId,
      timestamp: input.timestamp,
      butlerData: this.options.conversationMetricsButlerData,
    });
  }

  private shouldAdmitSemanticConversation(envelope: InboundEnvelope): boolean {
    return envelope.transport !== "system";
  }

  private finalizeConversationAdmissionFailure(
    admission: ConversationAdmissionTurn | null,
    timestamp: string,
    cause: unknown,
  ): void {
    if (!admission) return;
    try {
      admission.finalize("failed", timestamp);
    } catch {
      recordSystemEvent({
        sessionId: this.sessionId,
        category: "conversation.admission.finalize_failed",
        message: safeRuntimeFailure(cause).message,
        metadata: {
          source: "gateway-actor",
        },
        timestamp,
      });
    }
  }

  private captureDeveloperModelTurn(input: DeveloperLogCaptureInput): void {
    try {
      this.options.captureDeveloperModelTurn?.(input);
    } catch {
      // Developer diagnostics must never affect the user turn.
    }
  }

  private async emitTurnAcknowledged(input: {
    binding: StoredSessionBinding;
    envelope: InboundEnvelope;
    route?: GatewayRoute;
    timestamp: string;
  }): Promise<boolean> {
    if (input.envelope.transport !== APP_TRANSPORT) return false;
    if (!this.options.deliverTurnEvent) return false;
    const acknowledgedEvent: RuntimeTurnEventInput = {
      kind: TURN_ACKNOWLEDGED_EVENT_KIND,
      createdAt: input.timestamp,
      payload: createTurnAcknowledgedPayload({
        safeLabel: "Request received. Preparing the work.",
        transport: input.envelope.transport,
      }),
    };
    try {
      await this.options.deliverTurnEvent({
        binding: input.binding,
        envelope: input.envelope,
        route: input.route,
        event: acknowledgedEvent,
      });
      return true;
    } catch {
      // Acknowledgement is a public latency channel; durable inbound remains authoritative.
      return false;
    }
  }

  private async emitAcceptedFirstProgress(input: {
    binding: StoredSessionBinding;
    envelope: InboundEnvelope;
    route?: GatewayRoute;
    timestamp: string;
  }): Promise<boolean> {
    if (input.envelope.transport !== APP_TRANSPORT) return false;
    if (!this.options.deliverTurnEvent) return false;
    const payload = firstVisibleProgressPayload({
      note: FIRST_VISIBLE_PROGRESS_GATEWAY_NOTE,
      source: FIRST_VISIBLE_PROGRESS_GATEWAY_SOURCE,
    });
    try {
      await this.options.deliverTurnEvent({
        binding: input.binding,
        envelope: input.envelope,
        route: input.route,
        event: {
          kind: "turn.first_progress",
          createdAt: timestampAfter(input.timestamp, 1),
          payload,
        },
      });
      return true;
    } catch {
      // First progress is a latency channel; durable turn admission remains authoritative.
      return false;
    }
  }

  private async emitOpeningDecision(input: {
    binding: StoredSessionBinding;
    envelope: InboundEnvelope;
    route?: GatewayRoute;
    timestamp: string;
  }): Promise<string | undefined> {
    if (input.envelope.transport !== APP_TRANSPORT) return undefined;
    const turnProvider = bindProviderToModel(this.options.provider, input.binding.modelRef);
    if (
      this.role === "butler" &&
      turnProvider.capabilities.supportsStructuredOutputs === true
    ) return undefined;
    const timeoutMs = this.options.openingDecisionTimeoutMs ?? DEFAULT_OPENING_DECISION_TIMEOUT_MS;
    if (timeoutMs <= 0) {
      return undefined;
    }
    try {
      const openingDecision = await generateOpeningDecisionWithProvider(
        turnProvider,
        {
          userMessage: input.envelope.message.text ?? "",
          model: input.binding.modelRef,
          sessionRole: input.binding.role,
          projectId: input.binding.projectId,
          signal: input.envelope.signal,
          timeoutMs,
        },
      );
      if (!openingDecision) {
        this.recordOpeningDecisionDiagnostic(input, "generation_returned_null");
        return undefined;
      }
      if (!this.options.deliverTurnEvent) {
        this.recordOpeningDecisionDiagnostic(input, "delivery_failed");
        return undefined;
      }
      try {
        await this.options.deliverTurnEvent({
          binding: input.binding,
          envelope: input.envelope,
          route: input.route,
          event: {
            kind: TURN_DECISION_EVENT_KIND,
            createdAt: timestampAfter(input.timestamp, 2),
            payload: { ...openingDecision },
          },
        });
      } catch (error) {
        this.recordOpeningDecisionDiagnostic(
          input,
          "delivery_failed",
          error,
        );
        return undefined;
      }
      return openingDecision.decisionId;
    } catch (error) {
      this.recordOpeningDecisionDiagnostic(input, "generation_threw", error);
      return undefined;
    }
  }

  private recordOpeningDecisionDiagnostic(
    input: {
      binding: StoredSessionBinding;
      envelope: InboundEnvelope;
      timestamp: string;
    },
    reason: "generation_returned_null" | "generation_threw" | "delivery_failed",
    error?: unknown,
  ): void {
    recordSystemEvent({
      sessionId: input.binding.sessionId,
      category: "opening_decision",
      message: "Opening decision was not emitted.",
      details: {
        reason,
        ...(error ? { diagnostics: diagnosticDetails(error) } : {}),
      },
      metadata: {
        source: "gateway-actor#opening-decision",
        turnId: turnIdFromEnvelope(input.envelope),
      },
      timestamp: input.timestamp,
    });
  }

  private async generateSessionTitleBestEffort(
    binding: StoredSessionBinding,
    envelope: InboundEnvelope,
    route?: GatewayRoute,
  ): Promise<string | null> {
    try {
      return (
        (await this.options.generateSessionTitle?.({
          binding,
          envelope,
          route,
        })) ?? null
      );
    } catch {
      return null;
    }
  }

  private async closeNow(reason = "gateway-close"): Promise<void> {
    const binding = this.requireBinding();
    const timestamp = this.options.now?.() || defaultNow();
    const handle = this.handle ?? this.resumeHandleFromBinding(binding);

    if (handle && this.options.runtime.closeSession) {
      await this.options.runtime.closeSession(handle);
    }

    this.handle = null;
    this.options.store.updateLifecycleState(
      binding.sessionId,
      "closed",
      timestamp,
    );
    recordSessionLifecycle({
      sessionId: binding.sessionId,
      role: binding.role,
      state: "closed",
      reason,
      metadata: {
        source: "gateway-lifecycle",
      },
      timestamp,
    });
  }

  private async invalidateRuntimeHandleIfLiveConfigChanged(
    binding: StoredSessionBinding,
    timestamp: string,
    promptContext?: string,
  ): Promise<void> {
    const nextHash = liveConfigHashFromPromptContext(promptContext);
    if (!nextHash) return;
    if (!this.liveConfigHash) {
      this.liveConfigHash = nextHash;
      return;
    }
    if (this.liveConfigHash === nextHash) return;
    const handle = this.handle ?? this.resumeHandleFromBinding(binding);
    if (handle && this.options.runtime.closeSession) {
      await this.options.runtime.closeSession(handle);
    }
    this.handle = null;
    this.liveConfigHash = nextHash;
    this.persistBinding(binding, {
      runtimeSessionRef: null,
      providerThreadRef: null,
      lifecycleState: "active",
      updatedAt: timestamp,
      lastActiveAt: timestamp,
    });
    recordSessionLifecycle({
      sessionId: binding.sessionId,
      role: binding.role,
      state: "active",
      reason: "live-config-refresh",
      metadata: {
        source: "gateway-lifecycle",
        liveConfigHash: nextHash,
      },
      timestamp,
    });
  }

  private requireBinding(): StoredSessionBinding {
    const binding = this.options.store.getBySessionId(this.options.sessionId);
    if (!binding) {
      throw new Error(
        `Missing stored session binding for ${this.options.sessionId}`,
      );
    }
    if (binding.role !== this.options.role) {
      throw new Error(
        `Session ${this.options.sessionId} has role ${binding.role}, expected ${this.options.role}`,
      );
    }
    return binding;
  }

  private async ensureRuntimeHandle(
    binding: StoredSessionBinding,
    timestamp: string,
  ): Promise<RuntimeSessionHandle> {
    if (this.handle) return this.handle;

    const resumed = this.resumeHandleFromBinding(binding);
    if (resumed) {
      this.handle = resumed;
      recordSessionLifecycle({
        sessionId: binding.sessionId,
        role: binding.role,
        state: "active",
        reason: "gateway-resume-session",
        metadata: {
          source: "gateway-lifecycle",
        },
        timestamp,
      });
      return resumed;
    }

    const created = await this.options.runtime.createSession({
      sessionId: binding.sessionId,
      role: binding.role,
      workspacePath: binding.workspacePath,
      systemPrompt: this.options.systemPrompt,
      tools: this.options.tools,
      metadata: {
        projectId: binding.projectId ?? null,
        source: "gateway-lifecycle",
      },
    });
    this.handle = created;
    this.persistBinding(binding, {
      runtimeSessionRef: created.runtimeSessionRef,
      lifecycleState: "active",
      updatedAt: timestamp,
      lastActiveAt: timestamp,
    });
    recordSessionLifecycle({
      sessionId: binding.sessionId,
      role: binding.role,
      state: "active",
      reason: "gateway-create-session",
      metadata: {
        source: "gateway-lifecycle",
      },
      timestamp,
    });
    return created;
  }

  private resumeHandleFromBinding(
    binding: StoredSessionBinding,
  ): RuntimeSessionHandle | null {
    if (!this.options.runtime.capabilities.supportsSessionResume) return null;
    if (!binding.runtimeSessionRef) return null;
    return {
      sessionId: binding.sessionId,
      role: binding.role,
      runtimeAdapterId: binding.runtimeAdapterId,
      runtimeSessionRef: binding.runtimeSessionRef,
    };
  }

  private startTypingPresence(input: {
    binding: StoredSessionBinding;
    envelope: InboundEnvelope;
    emitIntermediate?: (
      action: OutboundAction,
      metadata?: Record<string, unknown>,
    ) => Promise<void>;
  }): () => void {
    if (!input.emitIntermediate) return () => {};
    if (input.envelope.transport === "system") return () => {};
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const emit = () => {
      if (stopped) return;
      void input
        .emitIntermediate?.(this.typingAction(input.binding, input.envelope), {
          source: "gateway-actor",
          type: "presence",
          presence: "typing",
        })
        .catch((error) => {
          recordSystemEvent({
            sessionId: input.binding.sessionId,
            category: "delivery_error",
            message: error instanceof Error ? error.message : String(error),
            metadata: {
              source: "gateway-actor#typing-presence",
            },
            timestamp: this.options.now?.() || defaultNow(),
          });
        });
      timer = setTimeout(emit, DEFAULT_TYPING_INTERVAL_MS);
    };
    emit();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  private typingAction(
    binding: StoredSessionBinding,
    envelope: InboundEnvelope,
  ): OutboundAction {
    const threadId =
      envelope.peer.kind === "thread"
        ? envelope.peer.id
        : envelope.peer.parentId;
    const peerId =
      envelope.peer.kind === "thread" && envelope.peer.parentId
        ? envelope.peer.parentId
        : envelope.peer.id;
    return {
      actionId: `presence:${binding.sessionId}:${envelope.eventId}:typing:${Date.now()}`,
      transport: envelope.transport,
      accountId: envelope.accountId,
      peer: {
        kind: peerKindFromEnvelope(envelope.peer),
        id: peerId,
        threadId,
      },
      message: {},
      presence: {
        kind: "typing",
      },
      metadata: {
        source: "gateway-actor",
        type: "presence",
      },
    };
  }

  private persistBinding(
    binding: StoredSessionBinding,
    overrides: {
      runtimeSessionRef?: string | null;
      providerThreadRef?: string | null;
      lifecycleState?: StoredSessionBinding["lifecycleState"];
      updatedAt?: string;
      lastActiveAt?: string;
    },
  ): void {
    this.options.store.upsert({
      sessionId: binding.sessionId,
      role: binding.role,
      projectId: binding.projectId,
      workspacePath: binding.workspacePath,
      runtimeAdapterId: binding.runtimeAdapterId,
      modelProviderId: binding.modelProviderId,
      modelRef: binding.modelRef,
      runtimeSessionRef:
        overrides.runtimeSessionRef === undefined
          ? binding.runtimeSessionRef
          : (overrides.runtimeSessionRef ?? undefined),
      providerThreadRef:
        overrides.providerThreadRef === undefined
          ? binding.providerThreadRef
          : (overrides.providerThreadRef ?? undefined),
      transportBindings: binding.transportBindings,
      metadata: binding.metadata,
      lifecycleState: overrides.lifecycleState ?? binding.lifecycleState,
      createdAt: binding.createdAt,
      updatedAt: overrides.updatedAt,
      lastActiveAt: overrides.lastActiveAt,
    });
  }
}

function schedulerContinuationMetadata(envelope: InboundEnvelope): {
  contextAtomId: string;
  continuationForQueueId?: string;
  checkpointId?: string;
  schedulerItemId?: string;
} | null {
  const raw = envelope.raw && typeof envelope.raw === "object"
    ? envelope.raw as Record<string, unknown>
    : {};
  if (raw.sameLogicalTurnContinuation !== true) return null;
  const contextAtomId = typeof raw.contextAtomId === "string" ? raw.contextAtomId.trim() : "";
  if (!contextAtomId) return null;
  const continuationForQueueId = typeof raw.continuationForQueueId === "string"
    ? raw.continuationForQueueId
    : undefined;
  const checkpointId = typeof raw.checkpointId === "string" ? raw.checkpointId.trim() : undefined;
  const schedulerItemId = typeof raw.schedulerItemId === "string" ? raw.schedulerItemId.trim() : undefined;
  return { contextAtomId, continuationForQueueId, checkpointId, schedulerItemId };
}

function timestampAfter(timestamp: string, offsetMs: number): string {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return new Date().toISOString();
  return new Date(time + offsetMs).toISOString();
}
