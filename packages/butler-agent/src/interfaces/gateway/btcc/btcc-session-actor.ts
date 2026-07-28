import type { BtccTurnOutcome } from "../../../agent/btcc/index.ts";
import { isBtccOperationalInterruption } from
  "../../../agent/btcc/recovery/index.ts";
import type { RuntimeTurnEventInput } from "../../../agent/events/turn-events.ts";
import type {
  GatewayActorTurnResult,
  GatewayRoute,
  GatewaySessionActor,
} from "../../../gateways/core/contracts.ts";
import type {
  InboundEnvelope,
  StoredSessionBinding,
} from "../../../test-support/harness/contracts.ts";
import { admitGatewayCommand } from "./admit-gateway-command.ts";
import type { BtccGatewayActorOptions } from "./contracts.ts";
import { projectTurnOutcome } from "./project-turn-outcome.ts";
import { projectTurnProgress } from "./project-turn-progress.ts";
import { snapshotGatewayContext } from "./snapshot-gateway-context.ts";
import { GatewayConversationTurn } from "./conversation/index.ts";

export class BtccGatewaySessionActor implements GatewaySessionActor {
  readonly sessionId: string;
  readonly role: StoredSessionBinding["role"];

  constructor(private readonly options: BtccGatewayActorOptions) {
    this.sessionId = options.binding.sessionId;
    this.role = options.binding.role;
  }

  async handleInbound(
    envelope: InboundEnvelope,
    route?: GatewayRoute,
  ): Promise<GatewayActorTurnResult> {
    const binding = this.requireBinding();
    const turnId = envelope.routingHints?.turnId?.trim() || envelope.eventId;
    const conversation = GatewayConversationTurn.begin({
      store: this.options.conversationStore,
      binding,
      envelope,
      turnId,
      butlerData: this.options.butlerData,
    });
    const assembly = conversation.includeRecentContext(
      this.options.promptAssembler.buildButlerContextAssembly({
        binding,
        envelope,
        route,
      }),
    );
    const context = snapshotGatewayContext({
      binding,
      assembly,
      documents: this.options.contextDocuments,
    });
    const command = admitGatewayCommand({ binding, envelope, turnId, context });
    const publish = async (event: RuntimeTurnEventInput) => {
      conversation.admitTurnEvent(event);
      await this.publish(envelope, route, event);
    };

    if (command.kind !== "resume") {
      await publish({ kind: "turn.started" });
    }
    const stopObserving = this.options.observeTurn(
      turnId,
      projectTurnProgress(publish),
    );
    let outcome: BtccTurnOutcome;
    try {
      outcome = await this.handleCommand(command, stopObserving);
    } catch (error) {
      if (isBtccOperationalInterruption(error)) {
        const notice = operationalNotice(error.activation.kind);
        if (notice) await this.publish(envelope, route, notice);
      }
      throw error;
    }
    const result = projectTurnOutcome(outcome);
    const generatedSessionTitle = result.text
      ? await this.options.generateSessionTitle?.({ binding, envelope, route }) ?? null
      : null;
    if (result.text) conversation.complete(result.text);
    else conversation.cancel();

    return {
      text: result.text,
      generatedSessionTitle,
      raw: { btccOutcome: outcome, durableFinalRecorded: false },
    };
  }

  async close(): Promise<void> {}

  private async handleCommand(
    command: Parameters<BtccGatewayActorOptions["runtime"]["runTurn"]>[0],
    stopObserving: () => void,
  ): Promise<BtccTurnOutcome> {
    try {
      return await this.options.runtime.runTurn(command);
    } finally {
      stopObserving();
    }
  }

  private requireBinding(): StoredSessionBinding {
    const binding = this.options.store.getBySessionId(this.sessionId);
    if (!binding) throw new Error(`Missing stored BTCC session binding: ${this.sessionId}`);
    return binding;
  }

  private async publish(
    envelope: InboundEnvelope,
    route: GatewayRoute | undefined,
    event: Parameters<NonNullable<BtccGatewayActorOptions["deliverTurnEvent"]>>[0]["event"],
  ): Promise<void> {
    await this.options.deliverTurnEvent?.({
      binding: this.requireBinding(),
      envelope,
      route,
      event: { visibility: "public", ...event },
    });
  }
}

function operationalNotice(
  activation: import("../../../agent/btcc/recovery/index.ts").OperationalActivation["kind"],
): RuntimeTurnEventInput | null {
  if (activation === "cancelled") return { kind: "turn.cancelled" };
  if (activation === "runtime_remediation") return null;
  const note = activation === "automatic_provider_recovery"
    ? "모델 연결을 복구하고 있습니다"
    : activation === "automatic_storage_recovery"
      ? "저장소 쓰기 순서를 조정하고 있습니다"
      : "선택한 모델 연결 설정을 확인해 주세요";
  return { kind: "assistant.public_note", payload: { note, operational: true } };
}
