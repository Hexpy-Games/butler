import { basename, isAbsolute } from "node:path";
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
import {
  recordDurableInbound,
  recordDurableOutbound,
  recordSessionLifecycle,
  recordSystemEvent,
} from "../../test-support/harness/durable-session-transcript.ts";
import { SessionBindingStore } from "../../test-support/harness/session-store.ts";
import { diagnosticDetails, safeRuntimeFailure } from "../../integrations/providers/provider-errors.ts";
import type { GatewayActorTurnResult, GatewayDurableRole, GatewayRoute, GatewaySessionActor } from "../../gateways/core/contracts.ts";

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
  }) => string | undefined;
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

function peerKindFromEnvelope(peer: InboundEnvelope["peer"]): OutboundAction["peer"]["kind"] {
  return peer.kind;
}

function turnIdFromEnvelope(envelope: InboundEnvelope): string {
  return envelope.routingHints?.turnId?.trim() ||
    envelope.eventId.replace(/[^A-Za-z0-9._:-]/g, "_");
}

function liveConfigHashFromPromptContext(promptContext?: string): string | null {
  const match = promptContext?.match(/^Live Configuration Hash:\s*([A-Za-z0-9_-]+)/mu);
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

function outboundArtifacts(artifacts?: ArtifactRef[]): ArtifactRef[] | undefined {
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
  const text = stripControlCharacters(value ?? "").replace(/\s+/gu, " ").trim();
  return (text || fallback).slice(0, 180);
}

function safeArtifactLabel(value: string | undefined): string | undefined {
  const label = stripControlCharacters(value ?? "").replace(/\s+/gu, " ").trim();
  if (!label) return undefined;
  const normalized = label.replace(/\\/gu, "/");
  const hasParentSegment = normalized.split("/").includes("..");
  const pathLike = isAbsolute(label) || /^[A-Za-z]:\//u.test(normalized) || hasParentSegment;
  return (pathLike ? basename(normalized) : label).slice(0, 180);
}

function stripControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
}

function finalResultAction(input: {
  binding: StoredSessionBinding;
  envelope: InboundEnvelope;
  text: string;
  artifacts?: ArtifactRef[];
  generatedSessionTitle?: string | null;
  loadedSkillNames?: string[];
}): OutboundAction {
  const threadId = input.envelope.peer.kind === "thread"
    ? input.envelope.peer.id
    : input.envelope.peer.parentId;
  const peerId = input.envelope.peer.kind === "thread" && input.envelope.peer.parentId
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
      emptyFinal: !input.text.trim(),
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

  async handleInbound(envelope: InboundEnvelope, route?: GatewayRoute): Promise<GatewayActorTurnResult> {
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

  private async handleInboundNow(envelope: InboundEnvelope, route?: GatewayRoute): Promise<GatewayActorTurnResult> {
    const binding = this.requireBinding();
    const timestamp = envelope.message.timestamp || this.options.now?.() || defaultNow();

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

    try {
      const promptContext = this.options.buildTurnContext?.({
        binding,
        envelope,
        route,
      });
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
      await this.invalidateRuntimeHandleIfLiveConfigChanged(binding, timestamp, promptContext);
      const activeBinding = this.requireBinding();
      const handle = await this.ensureRuntimeHandle(activeBinding, timestamp);
      const emitIntermediate = this.options.deliverIntermediate
        ? async (action: OutboundAction, metadata?: Record<string, unknown>) => {
            await this.options.deliverIntermediate?.({
              binding: activeBinding,
              envelope,
              route,
              action: actionWithTurnIdentity(action, activeBinding, envelope),
              metadata,
            });
          }
        : undefined;
      const emitTurnEvent = this.options.deliverTurnEvent
        ? async (event: RuntimeTurnEventInput) => {
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
      let result;
      try {
        result = await this.options.runtime.runTurn({
          handle,
          provider: this.options.provider,
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
            runtimePolicy: activeBinding.metadata?.runtimePolicy,
            workerModelRules: activeBinding.metadata?.workerModelRules,
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
        providerThreadRef: result.providerThreadRef ?? activeBinding.providerThreadRef,
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
      const generatedSessionTitle = await this.generateSessionTitleBestEffort(
        activeBinding,
        envelope,
        route,
      );
      recordDurableOutbound({
        sessionId: activeBinding.sessionId,
        action: finalResultAction({
          binding: activeBinding,
          envelope,
          text: result.text,
          artifacts: result.artifacts,
          generatedSessionTitle,
          loadedSkillNames,
        }),
        timestamp,
        metadata: {
          source: "gateway-actor#runtime-result",
          turnId: turnIdFromEnvelope(envelope),
        },
      });

      return {
        text: result.text,
        deliveries: result.deliveries,
        artifacts: result.artifacts,
        generatedSessionTitle,
        loadedSkillNames,
        providerThreadRef: result.providerThreadRef,
        runtimeSessionRef: nextHandle.runtimeSessionRef,
        raw: result.raw,
      };
    } catch (error) {
      const err = asError(error);
      const safeFailure = safeRuntimeFailure(error);
      const failureState = safeFailure.code === "goal_completion_incomplete"
        ? "active"
        : "crashed";
      this.options.store.updateLifecycleState(binding.sessionId, failureState, timestamp);
      recordSessionLifecycle({
        sessionId: binding.sessionId,
        role: binding.role,
        state: failureState,
        reason: failureState === "active"
          ? "gateway-turn-incomplete"
          : "gateway-runtime-error",
        metadata: {
          message: safeFailure.message,
          code: safeFailure.code,
          diagnostics: diagnosticDetails(error),
        },
        timestamp,
      });
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
      throw err;
    }
  }

  private async generateSessionTitleBestEffort(
    binding: StoredSessionBinding,
    envelope: InboundEnvelope,
    route?: GatewayRoute,
  ): Promise<string | null> {
    try {
      return await this.options.generateSessionTitle?.({
        binding,
        envelope,
        route,
      }) ?? null;
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
    this.options.store.updateLifecycleState(binding.sessionId, "closed", timestamp);
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
      throw new Error(`Missing stored session binding for ${this.options.sessionId}`);
    }
    if (binding.role !== this.options.role) {
      throw new Error(
        `Session ${this.options.sessionId} has role ${binding.role}, expected ${this.options.role}`,
      );
    }
    return binding;
  }

  private async ensureRuntimeHandle(binding: StoredSessionBinding, timestamp: string): Promise<RuntimeSessionHandle> {
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

  private resumeHandleFromBinding(binding: StoredSessionBinding): RuntimeSessionHandle | null {
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
    emitIntermediate?: (action: OutboundAction, metadata?: Record<string, unknown>) => Promise<void>;
  }): () => void {
    if (!input.emitIntermediate) return () => {};
    if (input.envelope.transport === "system") return () => {};
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const emit = () => {
      if (stopped) return;
      void input.emitIntermediate?.(this.typingAction(input.binding, input.envelope), {
        source: "gateway-actor",
        type: "presence",
        presence: "typing",
      }).catch((error) => {
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

  private typingAction(binding: StoredSessionBinding, envelope: InboundEnvelope): OutboundAction {
    const threadId = envelope.peer.kind === "thread" ? envelope.peer.id : envelope.peer.parentId;
    const peerId = envelope.peer.kind === "thread" && envelope.peer.parentId
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
      runtimeSessionRef: overrides.runtimeSessionRef === undefined
        ? binding.runtimeSessionRef
        : overrides.runtimeSessionRef ?? undefined,
      providerThreadRef: overrides.providerThreadRef === undefined
        ? binding.providerThreadRef
        : overrides.providerThreadRef ?? undefined,
      transportBindings: binding.transportBindings,
      metadata: binding.metadata,
      lifecycleState: overrides.lifecycleState ?? binding.lifecycleState,
      createdAt: binding.createdAt,
      updatedAt: overrides.updatedAt,
      lastActiveAt: overrides.lastActiveAt,
    });
  }
}
