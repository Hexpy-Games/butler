import type {
  AgentRuntimeAdapter,
  InboundEnvelope,
  ModelProviderAdapter,
  OutboundAction,
  RuntimeTurnEventInput,
  StoredSessionBinding,
} from "../../test-support/harness/contracts.ts";
import { SessionBindingStore } from "../../test-support/harness/session-store.ts";
import type { GatewayRoleHandlers, GatewayRoute, GatewaySessionActor } from "../../gateways/core/contracts.ts";
import { ButlerSessionActor } from "./butler-session.ts";
import type { PolicyApprovalMode, PolicyToolDefinition } from "../../agent/policy/policy-engine.ts";
import { PolicyEngine } from "../../agent/policy/policy-engine.ts";
import { PromptAssembler } from "../../agent/prompt/prompt-assembler.ts";
import { normalizeModelRef, type SessionTitleGenerator } from "../../agent/output/session-title.ts";
import { StewardSessionActor } from "./steward-session.ts";
import { recordSystemEvent } from "../../test-support/harness/durable-session-transcript.ts";
import type { ConversationWriter } from "../../agent/conversation/types.ts";
import type {
  DeveloperLogCaptureInput,
  DeveloperLogStore,
} from "../../operations/diagnostics/developer-log-store.ts";
import type { BtccInterruptionStateWriter } from "../../agent/conversation/session-admission.ts";

export interface SessionLifecycleServiceOptions {
  store: SessionBindingStore;
  runtime: AgentRuntimeAdapter;
  provider: ModelProviderAdapter;
  systemPromptFactory?: (binding: StoredSessionBinding) => string;
  promptAssembler?: PromptAssembler;
  policyEngine?: PolicyEngine;
  tools?: PolicyToolDefinition[];
  approvalMode?: PolicyApprovalMode;
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
  conversationWriter?: ConversationWriter;
  btccInterruptionStateWriter?: BtccInterruptionStateWriter;
  conversationMetricsButlerData?: string;
  sessionTitleGenerator?: SessionTitleGenerator | false;
  openingDecisionTimeoutMs?: number;
  developerLogStore?: DeveloperLogStore;
  developerDiagnosticsEnabled?: () => boolean;
  now?: () => string;
}

function defaultSystemPrompt(binding: StoredSessionBinding): string {
  return `role=${binding.role}\nsession=${binding.sessionId}\nworkspace=${binding.workspacePath}`;
}

function defaultNow(): string {
  return new Date().toISOString();
}

export class SessionLifecycleService {
  private readonly actors = new Map<string, GatewaySessionActor>();
  private readonly actorCreations = new Map<string, Promise<GatewaySessionActor>>();
  private readonly projectCapsuleRequests = new Set<string>();

  constructor(private readonly options: SessionLifecycleServiceOptions) {}

  async actorForRoute(route: GatewayRoute): Promise<GatewaySessionActor> {
    return this.getOrCreate(route.sessionId, route.role);
  }

  async getOrCreate(sessionId: string, expectedRole?: GatewayRoute["role"]): Promise<GatewaySessionActor> {
    const existing = this.actors.get(sessionId);
    if (existing) return existing;
    const creating = this.actorCreations.get(sessionId);
    if (creating) return await creating;

    const creation = this.createAndStoreActor(sessionId, expectedRole);
    this.actorCreations.set(sessionId, creation);
    try {
      return await creation;
    } finally {
      this.actorCreations.delete(sessionId);
    }
  }

  private async createAndStoreActor(
    sessionId: string,
    expectedRole?: GatewayRoute["role"],
  ): Promise<GatewaySessionActor> {
    const binding = this.options.store.getBySessionId(sessionId);
    if (!binding) {
      throw new Error(`Missing stored session binding for ${sessionId}`);
    }
    if (expectedRole && binding.role !== expectedRole) {
      throw new Error(`Stored session ${sessionId} has role ${binding.role}, expected ${expectedRole}`);
    }

    const actor = this.createActor(binding);
    this.actors.set(sessionId, actor);
    return actor;
  }

  async closeSession(sessionId: string, reason?: string): Promise<void> {
    const actor = await this.getOrCreate(sessionId);
    await actor.close(reason);
    this.actors.delete(sessionId);
  }

  private createActor(binding: StoredSessionBinding): GatewaySessionActor {
    this.requestProjectCapsuleEnsure(binding);
    const shared = {
      sessionId: binding.sessionId,
      store: this.options.store,
      runtime: this.options.runtime,
      provider: this.options.provider,
      systemPrompt:
        this.options.systemPromptFactory?.(binding) ??
        this.options.promptAssembler?.buildSystemPrompt(binding).systemPrompt ??
        defaultSystemPrompt(binding),
      tools:
        this.options.tools && this.options.tools.length > 0
          ? (this.options.policyEngine ?? new PolicyEngine()).filterTools({
              binding,
              tools: this.options.tools,
              approvalMode: this.options.approvalMode,
            })
          : undefined,
      buildTurnContext: this.options.promptAssembler
        ? (input: { binding: StoredSessionBinding; envelope: InboundEnvelope; route?: GatewayRoute }) => {
            const promptAssembler = this.options.promptAssembler;
            const canBuildAssembly =
              typeof promptAssembler?.buildContextAssembly === "function" &&
              typeof promptAssembler?.renderTurnContext === "function";
            if (!canBuildAssembly) {
              const promptContext = promptAssembler?.buildTurnContext?.({
                binding: input.binding,
                envelope: input.envelope,
                route: input.route,
              });
              return typeof promptContext === "string"
                ? { promptContext }
                : undefined;
            }
            const assembly = promptAssembler.buildContextAssembly({
              binding: input.binding,
              envelope: input.envelope,
              route: input.route,
            });
            return assembly
              ? {
                  contextAssembly: assembly,
                  promptContext: promptAssembler.renderTurnContext(assembly),
                }
              : undefined;
          }
        : undefined,
      captureDeveloperModelTurn: this.options.developerLogStore
        ? (input: DeveloperLogCaptureInput) => {
            if (this.options.developerDiagnosticsEnabled?.() !== true) return;
            if (input.kind === "model_turn_error") {
              this.options.developerLogStore?.appendModelTurnError(input);
              return;
            }
            this.options.developerLogStore?.appendModelTurn(input);
          }
        : undefined,
      deliverIntermediate: this.options.deliverIntermediate,
      deliverTurnEvent: this.options.deliverTurnEvent,
      conversationWriter: this.options.conversationWriter,
      btccInterruptionStateWriter: this.options.btccInterruptionStateWriter,
      conversationMetricsButlerData: this.options.conversationMetricsButlerData,
      generateSessionTitle: this.options.sessionTitleGenerator
        ? async ({ binding, envelope }: {
            binding: StoredSessionBinding;
            envelope: InboundEnvelope;
            route?: GatewayRoute;
          }) => {
            const text = (envelope.message.text ?? "").trim();
            if (!text || !this.options.sessionTitleGenerator) return null;
            try {
              return await this.options.sessionTitleGenerator({
                text,
                model: normalizeModelRef(binding.modelRef),
                signal: envelope.signal,
              }) ?? null;
            } catch {
              return null;
            }
          }
        : undefined,
      openingDecisionTimeoutMs: this.options.openingDecisionTimeoutMs,
      now: this.options.now,
    };

    return binding.role === "butler"
      ? new ButlerSessionActor(shared)
      : new StewardSessionActor(shared);
  }

  private requestProjectCapsuleEnsure(binding: StoredSessionBinding): void {
    if (!binding.projectId || !this.options.promptAssembler) return;
    if (
      typeof this.options.promptAssembler.projectCapsuleStatus !== "function" ||
      typeof this.options.promptAssembler.ensureProjectCapsule !== "function"
    ) {
      return;
    }
    if (this.options.promptAssembler.projectCapsuleStatus(binding) !== "missing") return;
    const key = `${binding.projectId}\u0000${binding.workspacePath}`;
    if (this.projectCapsuleRequests.has(key)) return;
    this.projectCapsuleRequests.add(key);
    this.scheduleProjectCapsuleEnsure(binding, key, 1, 0);
  }

  private scheduleProjectCapsuleEnsure(
    binding: StoredSessionBinding,
    key: string,
    attempt: number,
    delayMs: number,
  ): void {
    const maxAttempts = 3;
    setTimeout(() => {
      let keepRequest = false;
      try {
        const result = this.options.promptAssembler?.ensureProjectCapsule(binding);
        if (result?.status === "failed") {
          recordSystemEvent({
            sessionId: binding.sessionId,
            category: "project_memory_refresh",
            message: result.error,
            metadata: {
              source: "session-lifecycle",
              projectId: binding.projectId ?? null,
              attempt,
              maxAttempts,
            },
            timestamp: this.options.now?.() ?? defaultNow(),
          });
          if (attempt < maxAttempts) {
            keepRequest = true;
            this.scheduleProjectCapsuleEnsure(binding, key, attempt + 1, 250 * attempt);
            return;
          }
        }
      } catch (error) {
        recordSystemEvent({
          sessionId: binding.sessionId,
          category: "project_memory_refresh",
          message: error instanceof Error ? error.message : String(error),
          metadata: {
            source: "session-lifecycle",
            projectId: binding.projectId ?? null,
            attempt,
            maxAttempts,
          },
          timestamp: this.options.now?.() ?? defaultNow(),
        });
        if (attempt < maxAttempts) {
          keepRequest = true;
          this.scheduleProjectCapsuleEnsure(binding, key, attempt + 1, 250 * attempt);
          return;
        }
      } finally {
        if (!keepRequest) this.projectCapsuleRequests.delete(key);
      }
    }, delayMs);
  }
}

export function createLifecycleGatewayHandlers(lifecycle: SessionLifecycleService): GatewayRoleHandlers {
  const resultMetadata = async (
    route: GatewayRoute,
    envelope: InboundEnvelope,
    result: Awaited<ReturnType<GatewaySessionActor["handleInbound"]>>,
  ) => ({
    text: result.text,
    artifacts: result.artifacts ?? [],
    delivery_state: result.delivery?.delivery_state,
    limitation_codes: result.delivery?.limitation_codes,
    limitations: result.delivery?.limitations,
    deliveryCount: result.deliveries?.length ?? 0,
    runtimeSessionRef: result.runtimeSessionRef ?? null,
    providerThreadRef: result.providerThreadRef ?? null,
    durableFinalRecorded: true,
    generatedSessionTitle: result.generatedSessionTitle ?? null,
    loadedSkillNames: result.loadedSkillNames ?? [],
  });
  return {
    butler: async ({ route, envelope }) => {
      const actor = await lifecycle.actorForRoute(route);
      const result = await actor.handleInbound(envelope, route);
      return {
        ok: true,
        handledBy: "butler-session-actor",
        metadata: await resultMetadata(route, envelope, result),
      };
    },
    steward: async ({ route, envelope }) => {
      const actor = await lifecycle.actorForRoute(route);
      const result = await actor.handleInbound(envelope, route);
      return {
        ok: true,
        handledBy: "steward-session-actor",
        metadata: await resultMetadata(route, envelope, result),
      };
    },
  };
}
