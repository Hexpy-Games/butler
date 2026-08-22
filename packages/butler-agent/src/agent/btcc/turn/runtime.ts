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
import { isGuidedWorkCloseoutError } from "../agent-loop/index.ts";
import {
  isPhaseContinuityProjectionError,
  isRoundToolSurfaceError,
} from "../ports/model-round.ts";
import {
  isModelRouteDurabilityError,
  ModelRouteRecoveredFailureError,
} from "../model-route/index.ts";
import {
  ModelProviderRequestError,
  diagnosticDetails,
  safeRuntimeFailure,
} from "../../../integrations/providers/provider-errors.ts";
import { createModelRouteRuntimeHooks } from "./model-route-runtime-hooks.ts";
import { isPhaseScopedMemoryProjectionError } from
  "../../context/context-projection.ts";
import { operationalFailureMessage } from "./turn-runtime-failure.ts";
import { guidedFinalTransition } from "./guided-final-transition.ts";
import {
  createNoopRuntimeMemoryAttributionPort,
  type RuntimeMemoryAttributionPort,
} from "../../../operations/diagnostics/runtime-memory-attribution/index.ts";
import {
  createNoopTurnDeveloperLogCapturePort,
  type TurnDeveloperLogCapturePort,
} from "../../../operations/diagnostics/developer-log-turn-capture/index.ts";

export type TurnRuntimeDependencies = {
  admission: TurnAdmissionRepository;
  turns: TurnStateRepository;
  messages: CanonicalMessageStore;
  agent: BtccAgentLoop;
  memoryAttribution?: RuntimeMemoryAttributionPort;
  developerLogCapture?: TurnDeveloperLogCapturePort;
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
  private readonly memoryAttribution: RuntimeMemoryAttributionPort;
  private readonly developerLogCapture: TurnDeveloperLogCapturePort;

  constructor(private readonly dependencies: TurnRuntimeDependencies) {
    this.memoryAttribution = dependencies.memoryAttribution ??
      createNoopRuntimeMemoryAttributionPort();
    this.developerLogCapture = dependencies.developerLogCapture ??
      createNoopTurnDeveloperLogCapturePort();
  }
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
    this.memoryAttribution.checkpoint({ event: "turn_start", operation: "turn" });
    try {
      return await this.runTurnLifecycle(command, progress, onAdmitted);
    } finally {
      this.memoryAttribution.checkpoint({ event: "turn_end", operation: "turn" });
    }
  }

  private async runTurnLifecycle(
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
      turn = await this.runAgentAndCommit(turn, progress, command.recoveryAttempt);
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
    recoveryAttempt?: number,
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
          recoveryAttempt,
          signal: permit.signal,
          memoryAttribution: this.memoryAttribution,
          progress,
          ...createModelRouteRuntimeHooks({
            turn,
            claim,
            turns: this.dependencies.turns,
          }),
        });
        this.developerLogCapture.capture({
          kind: "model_turn",
          turn,
          result,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        this.developerLogCapture.capture({
          kind: "model_turn_error",
          turn,
          failure: safeRuntimeFailure(error),
          diagnostics: diagnosticDetails(error),
          timestamp: new Date().toISOString(),
        });
        if (isModelRouteDurabilityError(error) ||
            isPhaseContinuityProjectionError(error) ||
            isPhaseScopedMemoryProjectionError(error) ||
            isRoundToolSurfaceError(error) ||
            isGuidedWorkCloseoutError(error)) throw error;
        if (isRetryableProviderExhaustion(error)) {
          const failure = safeRuntimeFailure(error);
          const failureCode = error instanceof ModelRouteRecoveredFailureError
            ? error.failureCode
            : failure.code;
          await progress?.runtimeFaulted?.({
            turnId: turn.turnId,
            sessionId: turn.sessionId,
            faultId: `${turn.turnId}:provider-transport-exhausted`,
            kind: "provider_transport_exhausted",
            retryable: true,
            publicSummary: operationalFailureMessage(turn.originalMessage, error),
            operatorSummary: `Provider recovery exhausted (${failureCode}).`,
            safeErrorCode: failureCode,
            createdAt: new Date().toISOString(),
          });
          throw error;
        }
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
    this.memoryAttribution.terminal(
      turn.semanticState === "cancelled" ? "cancelled" : "delivered",
    );
    await publishState(progress, turn);
  }
}

function isRetryableProviderExhaustion(error: unknown): boolean {
  if (error instanceof ModelProviderRequestError) return error.retryable;
  return error instanceof ModelRouteRecoveredFailureError &&
    error.disposition === "retry";
}

export function createTurnRuntime(dependencies: TurnRuntimeDependencies): BtccTurnRuntime {
  return new DefaultTurnRuntime(dependencies);
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
