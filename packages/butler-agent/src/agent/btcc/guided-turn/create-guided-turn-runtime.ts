import type {
  BtccRunCommand,
  BtccStopCommand,
  BtccTurnOutcome,
  BtccTurnProgressObserver,
  BtccTurnRuntime,
} from "../contracts.ts";
import type { CanonicalMessageStore } from "../delivery/index.ts";
import { insertCanonicalMessage } from "../delivery/index.ts";
import { contentRef, digest } from "../identity.ts";
import { createTurnExecutionSupervisor } from "../recovery/index.ts";
import type { CommittedSuccessorReadiness } from "../recovery/index.ts";
import {
  loadOrAdmitTurn,
  projectTerminalOutcome,
  stopTurn,
  type TurnAdmissionRepository,
  type TurnRecord,
  type TurnStateRepository,
} from "../turn/index.ts";
import { acquireStateExecution } from "../turn/acquire-state-execution.ts";
import type { GuidedTurnAgent, GuidedTurnResult } from "./contracts.ts";

export type GuidedTurnRuntimeDependencies = {
  admission: TurnAdmissionRepository;
  turns: TurnStateRepository;
  messages: CanonicalMessageStore;
  agent: GuidedTurnAgent;
  progress?: BtccTurnProgressObserver;
  committedSuccessorReadiness?: CommittedSuccessorReadiness;
};

class DefaultGuidedTurnRuntime implements BtccTurnRuntime {
  private readonly supervisor = createTurnExecutionSupervisor();
  private readonly activeTurns = new Map<string, Promise<BtccTurnOutcome>>();

  constructor(private readonly dependencies: GuidedTurnRuntimeDependencies) {}

  runTurn(command: BtccRunCommand): Promise<BtccTurnOutcome> {
    const active = this.activeTurns.get(command.turnId);
    if (active) return active;
    const running = this.run(command).finally(() => this.activeTurns.delete(command.turnId));
    this.activeTurns.set(command.turnId, running);
    return running;
  }

  async stopTurn(command: BtccStopCommand): Promise<BtccTurnOutcome> {
    const outcome = await stopTurn(command, this.dependencies.turns, this.supervisor);
    if (outcome.kind === "cancelled") {
      const turn = await this.dependencies.turns.findTurn(command.turnId).catch(() => null);
      if (turn?.semanticState === "cancelled") await this.publishTerminal(turn);
    }
    return outcome;
  }

  private async run(command: BtccRunCommand): Promise<BtccTurnOutcome> {
    let turn = await loadOrAdmitTurn(command, this.dependencies);
    if (isTerminal(turn)) {
      await this.publishTerminal(turn);
      return projectTerminalOutcome(turn);
    }
    if (turn.semanticState !== "delivery_committed") {
      turn = await this.runAgentAndCommit(turn);
    }
    if (turn.semanticState === "cancelled") {
      await this.publishTerminal(turn);
      return projectTerminalOutcome(turn);
    }
    const delivered = await this.deliver(turn);
    return projectTerminalOutcome(delivered);
  }

  private async runAgentAndCommit(turn: TurnRecord): Promise<TurnRecord> {
    const permit = this.supervisor.enter({
      turnId: turn.turnId,
      executionFence: turn.executionFence,
      semanticState: turn.semanticState,
    });
    try {
      const claim = await acquireStateExecution(turn, this.dependencies, permit);
      let result: GuidedTurnResult;
      try {
        result = await this.dependencies.agent.run({
          turn,
          signal: permit.signal,
          progress: this.dependencies.progress,
        });
      } catch (_error) {
        permit.assertActive();
        result = {
          route: "assisted",
          content: operationalFailureMessage(turn.originalMessage),
        };
      }
      permit.assertActive();
      const transition = guidedFinalTransition(turn, result);
      await this.dependencies.turns.commitTransition({ turn, claim, transition });
      const committed = await this.dependencies.turns.activateCommittedSuccessor(turn.turnId);
      await this.publishDeliveryState(committed);
      return committed;
    } catch (error) {
      const current = await this.dependencies.turns.findTurn(turn.turnId).catch(() => null);
      if (current?.semanticState === "cancelled") return current;
      throw error;
    } finally {
      permit.close();
    }
  }

  private async deliver(initial: TurnRecord): Promise<TurnRecord> {
    let turn = initial;
    while (turn.semanticState === "delivery_committed") {
      const permit = this.supervisor.enter({
        turnId: turn.turnId,
        executionFence: turn.executionFence,
        semanticState: turn.semanticState,
      });
      try {
        const claim = await acquireStateExecution(turn, this.dependencies, permit);
        const message = await insertCanonicalMessage({
          turn,
          messages: this.dependencies.messages,
        });
        permit.assertActive();
        await this.dependencies.turns.commitTransition({
          turn,
          claim,
          transition: {
            kind: "observe_delivery",
            successor: "delivered",
            assistantMessageId: message.messageId,
          },
        });
        turn = await this.dependencies.turns.activateCommittedSuccessor(turn.turnId);
      } catch (error) {
        const current = await this.dependencies.turns.findTurn(turn.turnId).catch(() => null);
        if (permit.signal.aborted && current?.semanticState === "delivery_committed") {
          turn = current;
          continue;
        }
        if (current?.semanticState === "cancelled" || current?.semanticState === "delivered") {
          turn = current;
          break;
        }
        throw error;
      } finally {
        permit.close();
      }
    }
    if (!isTerminal(turn)) {
      throw new Error(`Guided Turn reached delivery from ${turn.semanticState}`);
    }
    await this.publishTerminal(turn);
    return turn;
  }

  private async publishDeliveryState(turn: TurnRecord): Promise<void> {
    if (turn.semanticState !== "delivery_committed") return;
    await publishState(this.dependencies.progress, turn);
  }

  private async publishTerminal(turn: TurnRecord): Promise<void> {
    if (!isTerminal(turn)) return;
    await publishState(this.dependencies.progress, turn);
  }
}

export function createGuidedTurnRuntime(
  dependencies: GuidedTurnRuntimeDependencies,
): BtccTurnRuntime {
  return new DefaultGuidedTurnRuntime(dependencies);
}

function guidedFinalTransition(turn: TurnRecord, result: GuidedTurnResult) {
  const content = result.content.trim() || operationalFailureMessage(turn.originalMessage);
  const finalPayloadBody = {
    turnId: turn.turnId,
    contentSha256: digest(content),
    route: result.route,
    disposition: "completed" as const,
    content,
  };
  const finalPayload = {
    ref: contentRef("payload", finalPayloadBody),
    ...finalPayloadBody,
  };
  const committedRevision = turn.revision + 1;
  const outboxId = digest(
    `btcc-canonical-delivery.v1\0${turn.turnId}\0${committedRevision}\0${finalPayload.ref.sha256}`,
  );
  return {
    kind: "accept_guided_final" as const,
    successor: "delivery_committed" as const,
    successorCheckpointKind: "runtime" as const,
    route: result.route,
    finalPayload,
    deliveryOutbox: {
      outboxId,
      finalPayloadRef: finalPayload.ref,
      expectedMessageId: digest(`btcc-assistant-message.v1\0${outboxId}`),
      content,
      status: "pending" as const,
    },
  };
}

async function publishState(
  observer: BtccTurnProgressObserver | undefined,
  turn: TurnRecord,
): Promise<void> {
  if (!observer) return;
  try {
    await observer.stateChanged({
      turnId: turn.turnId,
      semanticState: turn.semanticState,
      turnRevision: turn.revision,
    });
  } catch {
    // Public progress cannot veto durable Turn state.
  }
}

function isTerminal(turn: TurnRecord): boolean {
  return turn.semanticState === "delivered" || turn.semanticState === "cancelled";
}

function operationalFailureMessage(originalMessage: string): string {
  return /[가-힣]/.test(originalMessage)
    ? "요청을 처리하는 중 일시적인 문제가 발생했습니다. 작업은 안전하게 중단되었으며, 다시 요청해 주시면 이어서 처리하겠습니다."
    : "I hit a temporary problem while handling the request. The work stopped safely; please try again and I will continue.";
}
