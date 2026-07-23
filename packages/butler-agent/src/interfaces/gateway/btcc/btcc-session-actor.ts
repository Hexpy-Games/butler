import type { BtccTurnOutcome } from "../../../agent/btcc/index.ts";
import { isBtccOperationalInterruption } from "../../../agent/btcc/index.ts";
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
    const assembly = this.options.promptAssembler.buildButlerContextAssembly({
      binding,
      envelope,
      route,
    });
    const context = snapshotGatewayContext({
      binding,
      assembly,
      documents: this.options.contextDocuments,
    });
    const command = admitGatewayCommand({ binding, envelope, turnId, context });

    await this.publish(envelope, route, { kind: "turn.started" });
    const stopObserving = this.options.observeTurn(
      turnId,
      projectTurnProgress((event) => this.publish(envelope, route, event)),
    );
    let outcome: BtccTurnOutcome;
    try {
      outcome = await this.handleCommand(command, stopObserving);
    } catch (error) {
      if (isBtccOperationalInterruption(error)) {
        await this.publish(envelope, route, operationalNotice(error.activation.kind));
      }
      throw error;
    }
    const result = projectTurnOutcome(outcome);
    const generatedSessionTitle = result.text
      ? await this.options.generateSessionTitle?.({ binding, envelope, route }) ?? null
      : null;

    return {
      text: result.text,
      generatedSessionTitle,
      raw: { btccOutcome: outcome, durableFinalRecorded: false },
    };
  }

  async close(): Promise<void> {}

  private async handleCommand(
    command: Parameters<BtccGatewayActorOptions["runtime"]["handle"]>[0],
    stopObserving: () => void,
  ): Promise<BtccTurnOutcome> {
    try {
      return await this.options.runtime.handle(command);
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
): RuntimeTurnEventInput {
  if (activation === "cancelled") return { kind: "turn.cancelled" };
  const note = activation === "automatic_provider_recovery"
    ? "모델 연결이 복구되면 저장된 지점부터 이어서 진행합니다"
    : activation === "automatic_storage_recovery"
      ? "저장소 쓰기 순서가 확보되면 저장된 지점부터 이어서 진행합니다"
    : activation === "provider_action_required"
      ? "선택한 모델 연결 설정을 확인하면 저장된 지점부터 이어갈 수 있습니다"
      : "버틀러가 현재 작업을 안전하게 보류했습니다. 중지 기능은 계속 사용할 수 있습니다";
  return { kind: "assistant.public_note", payload: { note, operational: true } };
}
