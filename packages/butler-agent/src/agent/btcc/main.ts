import { conception } from "./conception/index.ts";
import { consolidation } from "./consolidation/index.ts";
import type {
  BtccRuntimeDependencies,
  BtccTurnCommand,
  BtccTurnOutcome,
  BtccTurnProgressObserver,
  BtccTurnRuntime,
} from "./contracts.ts";
import { insertCanonicalMessage, scheduleRetrospective } from "./delivery/index.ts";
import { planning } from "./planning/index.ts";
import { reporting } from "./reporting/index.ts";
import {
  createTurnExecutionSupervisor,
  correctionForOperationalInterruption,
  LedgerContentionInterruption,
  isBtccOperationalInterruption,
  OperationalInterruptionError,
  type OperationalCheckpointAnchor,
  type ExecutionPermit,
  type TurnExecutionSupervisor,
} from "./recovery/index.ts";
import type { ProviderCorrection } from "./core/index.ts";
import {
  createPhaseInvocation,
  decideTransition,
  loadOrAdmitTurn,
  projectTerminalOutcome,
  stopTurn,
  type ContinuingTurnCommand,
  type StateExecutionClaim,
  type TurnEvent,
  type TurnRecord,
} from "./turn/index.ts";
import { work } from "./work/index.ts";

class DefaultBtccTurnRuntime implements BtccTurnRuntime {
  private readonly supervisor = createTurnExecutionSupervisor();
  private readonly activeTurns = new Map<string, Promise<BtccTurnOutcome>>();

  constructor(private readonly dependencies: BtccRuntimeDependencies) {}

  handle(command: BtccTurnCommand): Promise<BtccTurnOutcome> {
    if (command.kind === "stop") {
      return stopTurn(command, this.dependencies.turns, this.supervisor);
    }
    const active = this.activeTurns.get(command.turnId);
    if (active) return active;
    const running = runBtccTurn(command, this.dependencies, this.supervisor)
      .finally(() => this.activeTurns.delete(command.turnId));
    this.activeTurns.set(command.turnId, running);
    return running;
  }
}

async function runBtccTurn(
  command: ContinuingTurnCommand,
  dependencies: BtccRuntimeDependencies,
  supervisor: TurnExecutionSupervisor,
): Promise<BtccTurnOutcome> {
  let turn = await loadOrAdmitTurn(command, dependencies);
  let providerCorrection: ProviderCorrection | undefined;
  turn = await dependencies.turns.activateCommittedSuccessor(turn.turnId);
  await publishProgress(dependencies.progress, turn);
  while (!isTerminal(turn)) {
    const permit = supervisor.enter({
      turnId: turn.turnId,
      executionFence: turn.executionFence,
      semanticState: turn.semanticState,
    });
    try {
      const claim = await dependencies.turns.acquireStateExecutionClaim(turn);
      const recovered = await recoverPersistedInterruption(
        dependencies,
        currentCheckpointBinding(claim),
        permit,
      );
      providerCorrection = correctionForOperationalInterruption(recovered) ?? providerCorrection;
      const event = await advanceBtccAlgorithm(
        turn,
        claim,
        dependencies,
        permit,
        providerCorrection,
      );
      permit.assertActive();
      const decision = decideTransition(turn, event);
      if (decision.kind === "rejected_unchanged") {
        throw new OperationalInterruptionError(
          `turn_transition_rejected_${decision.reason.kind}`,
          currentCheckpointBinding(claim),
        );
      }
      const transition = decision.transition;
      await dependencies.turns.commitTransition({ turn, claim, transition });
      await resolveOperationalInterruption(dependencies, currentCheckpointBinding(claim));
      providerCorrection = undefined;
      permit.assertActive();
    } catch (error) {
      if (error instanceof LedgerContentionInterruption) {
        try {
          await error.waitForRelease(permit.signal);
        } catch (waitError) {
          const stopped = await dependencies.turns.findTurn(turn.turnId);
          if (stopped && isTerminal(stopped)) {
            turn = stopped;
            continue;
          }
          throw waitError;
        }
        const reloaded = await dependencies.turns.findTurn(turn.turnId);
        if (!reloaded) throw new Error("Contended BTCC Turn disappeared", { cause: error });
        turn = reloaded;
        continue;
      }
      if (isBtccOperationalInterruption(error) && dependencies.operationalRecovery) {
        await publishOperationalNotice(dependencies.progress, {
          turnId: turn.turnId,
          status: "recovering",
          code: error.code,
          activationKind: error.activation.kind,
        });
        try {
          await dependencies.operationalRecovery.awaitReentry(error, permit.signal);
        } catch (recoveryError) {
          const stopped = await dependencies.turns.findTurn(turn.turnId);
          if (stopped && isTerminal(stopped)) {
            turn = stopped;
            continue;
          }
          throw recoveryError;
        }
        const reloaded = await dependencies.turns.findTurn(turn.turnId);
        if (!reloaded) throw new Error("Interrupted BTCC Turn disappeared", { cause: error });
        assertSameOperationalCheckpoint(reloaded, error.anchor);
        providerCorrection = correctionForOperationalInterruption(error);
        turn = reloaded;
        continue;
      }
      const observed = await dependencies.turns.findTurn(turn.turnId);
      if (observed && isTerminal(observed)) {
        turn = observed;
        continue;
      }
      throw error;
    } finally {
      permit.close();
    }
    turn = await activateCommittedSuccessor(turn.turnId, dependencies);
    await publishProgress(dependencies.progress, turn);
  }
  scheduleRetrospective({ turn, scheduler: dependencies.retrospective });
  return projectTerminalOutcome(turn);
}

async function recoverPersistedInterruption(
  dependencies: BtccRuntimeDependencies,
  anchor: OperationalCheckpointAnchor,
  permit: ExecutionPermit,
): Promise<OperationalInterruptionError | null> {
  const interruption = await dependencies.operationalRecovery?.resume(anchor, permit.signal);
  if (!interruption) return null;
  await publishOperationalNotice(dependencies.progress, {
    turnId: anchor.turnId,
    status: "recovering",
    code: interruption.code,
    activationKind: interruption.activation.kind,
  });
  permit.assertActive();
  return interruption;
}

async function publishOperationalNotice(
  observer: BtccTurnProgressObserver | undefined,
  update: {
    turnId: string;
    status: "recovering" | "cleared";
    code?: string;
    activationKind?: import("./recovery/index.ts").OperationalActivation["kind"];
  },
): Promise<void> {
  if (!observer?.operationalNoticeChanged) return;
  try {
    await observer.operationalNoticeChanged(update);
  } catch {
    // Projection cannot change durable recovery ownership.
  }
}

async function resolveOperationalInterruption(
  dependencies: BtccRuntimeDependencies,
  anchor: OperationalCheckpointAnchor,
): Promise<void> {
  if (!dependencies.operationalRecovery) return;
  try {
    const resolved = await dependencies.operationalRecovery.resolve(anchor);
    if (resolved) {
      await publishOperationalNotice(dependencies.progress, {
        turnId: anchor.turnId,
        status: "cleared",
      });
    }
  } catch {
    // A consumed claim prevents stale interruption records from being reactivated.
  }
}

function assertSameOperationalCheckpoint(
  turn: TurnRecord,
  anchor: OperationalCheckpointAnchor,
): void {
  const checkpoint = turn.checkpoint;
  if (
    turn.turnId !== anchor.turnId ||
    turn.revision !== anchor.turnRevision ||
    turn.semanticState !== anchor.semanticState ||
    turn.executionFence !== anchor.executionFence ||
    checkpoint?.checkpointId !== anchor.checkpointId ||
    checkpoint.checkpointRevision !== anchor.checkpointRevision
  ) {
    throw new Error("BTCC operational recovery lost its exact checkpoint binding");
  }
}

async function publishProgress(
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
    // User-visible projection is operational and cannot veto a committed semantic transition.
  }
}

async function advanceBtccAlgorithm(
  turn: TurnRecord,
  claim: StateExecutionClaim,
  dependencies: BtccRuntimeDependencies,
  executionPermit: ExecutionPermit,
  providerCorrection?: ProviderCorrection,
): Promise<TurnEvent> {
  const phase = () => createPhaseInvocation(
    turn,
    claim,
    dependencies,
    executionPermit,
    providerCorrection,
  );
  switch (turn.semanticState) {
    case "admitted":
      return { kind: "TurnActivated" };

    case "conception_opening":
    case "conception_deliberation":
    case "contract_review":
      return conception({
        cycle: "initial",
        turn,
        phase: phase(),
      });

    case "planning":
    case "planning_review":
      return planning({
        cycle: "initial",
        turn,
        phase: phase(),
      });

    case "work_frontier":
      return work({ turn, artifacts: dependencies.artifacts });
    case "task_execution":
    case "task_review":
    case "feedback_conception":
    case "feedback_planning":
    case "feedback_planning_review":
      return work({
        turn,
        phase: phase(),
        artifacts: dependencies.artifacts,
      });

    case "consolidation":
      return consolidation({ turn, phase: phase() });

    case "reporting":
      return reporting({ turn, phase: phase() });

    case "delivery_committed": {
      const message = await insertCanonicalMessage({ turn, messages: dependencies.messages });
      return { kind: "DeliveryObserved", assistantMessageId: message.messageId };
    }

    case "delivered":
    case "cancelled":
      throw new Error(`Terminal BTCC state cannot be advanced: ${turn.semanticState}`);
  }
}

function isTerminal(turn: TurnRecord): boolean {
  return turn.semanticState === "delivered" || turn.semanticState === "cancelled";
}

function currentCheckpointBinding(
  claim: StateExecutionClaim,
): OperationalCheckpointAnchor {
  return {
    turnId: claim.turnId,
    turnRevision: claim.turnRevision,
    semanticState: claim.semanticState,
    checkpointId: claim.checkpointId,
    checkpointRevision: claim.checkpointRevision,
    claimId: claim.claimId,
    executionFence: claim.executionFence,
  };
}

async function activateCommittedSuccessor(
  turnId: string,
  dependencies: BtccRuntimeDependencies,
): Promise<TurnRecord> {
  return dependencies.turns.activateCommittedSuccessor(turnId);
}

export function createBtccTurnRuntime(
  dependencies: BtccRuntimeDependencies,
): BtccTurnRuntime {
  return new DefaultBtccTurnRuntime(dependencies);
}
