/** Durable Turn runtime implementation; the public Turn facade remains in turn.ts. */
import type {
  BtccRunCommand,
  BtccStopCommand,
  BtccTurnOutcome,
  BtccTurnProgressObserver,
  BtccTurnRuntime,
} from "../contracts.ts";
import type { CanonicalMessageStore } from "../delivery/index.ts";
import { insertCanonicalMessage } from "../delivery/index.ts";
import { contentRef, digest } from "../identity/index.ts";
import { createTurnExecutionSupervisor } from "../recovery/index.ts";
import type { CommittedSuccessorReadiness } from "../recovery/index.ts";
import { acquireStateExecution } from "./acquire-state-execution.ts";
import { loadOrAdmitTurn } from "./load-or-admit-turn.ts";
import { projectTerminalOutcome } from "./project-terminal-outcome.ts";
import type {
  TurnAdmissionRepository,
  TurnRecord,
  TurnStateRepository,
} from "./contracts.ts";
import { stopTurn } from "./stop-turn.ts";
import { isSqliteContention } from "../../../foundation/sqlite-contention.ts";
import type { BtccAgentLoop, BtccAgentLoopResult } from "../agent-loop/index.ts";
import {
  isModelRouteDurabilityError,
  ModelRouteRecoveredFailureError,
} from "../model-route/index.ts";
import { ModelProviderRequestError } from
  "../../../integrations/providers/provider-errors.ts";
import { createModelRouteRuntimeHooks } from "./model-route-runtime-hooks.ts";

export type TurnRuntimeDependencies = {
  admission: TurnAdmissionRepository;
  turns: TurnStateRepository;
  messages: CanonicalMessageStore;
  agent: BtccAgentLoop;
  progress?: BtccTurnProgressObserver;
  committedSuccessorReadiness?: CommittedSuccessorReadiness;
};

/**
 * The only lifecycle runtime for a BTCC Turn.
 *
 * This module deliberately contains no model policy.  The model loop returns
 * a candidate final and this runtime owns durable admission, fencing,
 * canonical-message insertion, and delivery-state projection.
 */
class DefaultTurnRuntime implements BtccTurnRuntime {
  private readonly supervisor = createTurnExecutionSupervisor();
  private readonly activeTurns = new Map<string, Promise<BtccTurnOutcome>>();

  constructor(private readonly dependencies: TurnRuntimeDependencies) {}
  runTurn(
    command: BtccRunCommand,
    progress?: BtccTurnProgressObserver,
    onAdmitted?: (isFresh: boolean) => void | Promise<void>,
  ): Promise<BtccTurnOutcome> {
    const active = this.activeTurns.get(command.turnId);
    if (active) return active;
    const running = this.run(
      command,
      progress ?? this.dependencies.progress,
      onAdmitted,
    )
      .finally(() => this.activeTurns.delete(command.turnId));
    this.activeTurns.set(command.turnId, running);
    return running;
  }

  async stopTurn(command: BtccStopCommand): Promise<BtccTurnOutcome> {
    return stopTurn(command, this.dependencies.turns, this.supervisor);
  }

  private async run(
    command: BtccRunCommand,
    progress: BtccTurnProgressObserver | undefined,
    onAdmitted: ((isFresh: boolean) => void | Promise<void>) | undefined,
  ): Promise<BtccTurnOutcome> {
    let turn = await loadOrAdmitTurn(
      command,
      this.dependencies,
      (_admitted, isFresh) => onAdmitted?.(isFresh),
    );
    if (isTerminal(turn)) {
      await this.publishTerminal(progress, turn);
      return projectTerminalOutcome(turn);
    }
    if (turn.semanticState === "admitted") {
      await publishState(progress, turn);
    }
    if (turn.semanticState !== "delivery_committed") {
      turn = await this.runAgentAndCommit(turn, progress);
    }
    if (turn.semanticState === "cancelled") {
      await this.publishTerminal(progress, turn);
      return projectTerminalOutcome(turn);
    }
    const delivered = await this.deliver(turn, progress);
    return projectTerminalOutcome(delivered);
  }

  private async runAgentAndCommit(
    turn: TurnRecord,
    progress: BtccTurnProgressObserver | undefined,
  ): Promise<TurnRecord> {
    const permit = this.supervisor.enter({
      turnId: turn.turnId,
      executionFence: turn.executionFence,
      semanticState: turn.semanticState,
    });
    try {
      const claim = await acquireStateExecution(
        turn,
        { ...this.dependencies, progress },
        permit,
      );
      let result: BtccAgentLoopResult;
      try {
        result = await this.dependencies.agent.run({
          turn,
          signal: permit.signal,
          progress,
          ...createModelRouteRuntimeHooks({
            turn,
            claim,
            turns: this.dependencies.turns,
          }),
        });
      } catch (error) {
        if (isModelRouteDurabilityError(error)) throw error;
        permit.assertActive();
        result = {
          route: "assisted",
          content: operationalFailureMessage(turn.originalMessage, error),
        };
      }
      permit.assertActive();
      const transition = guidedFinalTransition(turn, result);
      while (true) {
        try {
          await this.dependencies.turns.commitTransition({ turn, claim, transition });
          break;
        } catch (error) {
          if (!isSqliteContention(error) || !this.dependencies.committedSuccessorReadiness) {
            throw error;
          }
          await this.dependencies.committedSuccessorReadiness
            .waitForStorageReadiness(permit.signal);
          permit.assertActive();
        }
      }
      const committed = await this.dependencies.turns.activateCommittedSuccessor(turn.turnId);
      await this.publishDeliveryState(progress, committed);
      return committed;
    } catch (error) {
      const current = await this.dependencies.turns.findTurn(turn.turnId).catch(() => null);
      if (current?.semanticState === "cancelled") return current;
      throw error;
    } finally {
      permit.close();
    }
  }

  private async deliver(
    initial: TurnRecord,
    progress: BtccTurnProgressObserver | undefined,
  ): Promise<TurnRecord> {
    let turn = initial;
    while (turn.semanticState === "delivery_committed") {
      const permit = this.supervisor.enter({
        turnId: turn.turnId,
        executionFence: turn.executionFence,
        semanticState: turn.semanticState,
      });
      try {
        const claim = await acquireStateExecution(
          turn,
          { ...this.dependencies, progress },
          permit,
        );
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
      throw new Error(`BTCC Turn reached delivery from ${turn.semanticState}`);
    }
    await this.publishTerminal(progress, turn);
    return turn;
  }

  private async publishDeliveryState(
    progress: BtccTurnProgressObserver | undefined,
    turn: TurnRecord,
  ): Promise<void> {
    if (turn.semanticState !== "delivery_committed") return;
    await publishState(progress, turn);
  }

  private async publishTerminal(
    progress: BtccTurnProgressObserver | undefined,
    turn: TurnRecord,
  ): Promise<void> {
    if (!isTerminal(turn)) return;
    await publishState(progress, turn);
  }
}

export function createTurnRuntime(dependencies: TurnRuntimeDependencies): BtccTurnRuntime {
  return new DefaultTurnRuntime(dependencies);
}

function guidedFinalTransition(turn: TurnRecord, result: BtccAgentLoopResult) {
  const content = result.content.trim() || operationalFailureMessage(turn.originalMessage);
  const finalPayloadBody = {
    turnId: turn.turnId,
    contentSha256: digest(content),
    route: result.route,
    disposition: "completed" as const,
    content,
    ...(result.modelIdentity ? { modelIdentity: result.modelIdentity } : {}),
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

function operationalFailureMessage(originalMessage: string, error?: unknown): string {
  const korean = /[가-힣]/.test(originalMessage);
  const kind = operationalFailureKind(error);
  if (korean) {
    if (kind === "transient_provider") {
      return "모델 연결이 일시적으로 중단되어 이 Turn의 답변을 완료하지 못했습니다. 저장된 작업과 확인된 결과는 변경하지 않았습니다.";
    }
    if (kind === "permanent_provider") {
      return "모델 제공자 설정 또는 요청이 승인되지 않아 이 Turn의 답변을 완료하지 못했습니다. 저장된 작업과 확인된 결과는 변경하지 않았습니다.";
    }
    return "내부 실행 오류로 이 Turn의 답변을 완료하지 못했습니다. 저장된 작업과 확인된 결과는 변경하지 않았습니다.";
  }
  if (kind === "transient_provider") {
    return "A temporary model connection failure prevented this Turn from completing. Saved work and verified results were not changed.";
  }
  if (kind === "permanent_provider") {
    return "The model provider rejected this Turn because of a configuration or request problem. Saved work and verified results were not changed.";
  }
  return "An internal execution error prevented this Turn from completing. Saved work and verified results were not changed.";
}

function operationalFailureKind(
  error: unknown,
): "transient_provider" | "permanent_provider" | "internal" {
  if (error instanceof ModelProviderRequestError) {
    return error.retryable ? "transient_provider" : "permanent_provider";
  }
  if (error instanceof ModelRouteRecoveredFailureError) {
    return error.disposition === "retry" ? "transient_provider" : "permanent_provider";
  }
  return "internal";
}
