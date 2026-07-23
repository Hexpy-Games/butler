import type { BtccRuntimeDependencies } from "../contracts.ts";
import type { ProviderCorrection } from "../core/index.ts";
import {
  correctionForOperationalInterruption,
  isBtccOperationalInterruption,
  LedgerContentionInterruption,
  OperationalInterruptionError,
  runtimeInterruption,
  type TurnExecutionSupervisor,
} from "../recovery/index.ts";
import {
  currentCheckpointBinding,
  recoverPersistedInterruption,
  resolveOperationalInterruption,
  waitForOperationalReentry,
} from "./operational-checkpoint.ts";
import { runCurrentPhase } from "./run-current-phase.ts";
import { decideTransition } from "./state-machine/index.ts";
import { publishTurnProgress } from "./turn-progress.ts";
import type {
  StateExecutionClaim,
  TurnRecord,
} from "./contracts.ts";

export async function advanceTurn(
  initial: TurnRecord,
  dependencies: BtccRuntimeDependencies,
  supervisor: TurnExecutionSupervisor,
): Promise<TurnRecord> {
  let turn = initial;
  let providerCorrection: ProviderCorrection | undefined;

  while (true) {
    const permit = supervisor.enter({
      turnId: turn.turnId,
      executionFence: turn.executionFence,
      semanticState: turn.semanticState,
    });
    let claim: StateExecutionClaim | undefined;

    try {
      claim = await dependencies.turns.acquireStateExecutionClaim(turn);
      const recovered = await recoverPersistedInterruption(
        dependencies,
        currentCheckpointBinding(claim),
        permit,
      );
      providerCorrection =
        correctionForOperationalInterruption(recovered) ?? providerCorrection;

      const event = await runCurrentPhase({
        turn,
        claim,
        dependencies,
        executionPermit: permit,
        providerCorrection,
      });
      permit.assertActive();

      const decision = decideTransition(turn, event);
      if (decision.kind === "rejected_unchanged") {
        throw new OperationalInterruptionError(
          `turn_transition_rejected_${decision.reason.kind}`,
          currentCheckpointBinding(claim),
        );
      }
      await dependencies.turns.commitTransition({
        turn,
        claim,
        transition: decision.transition,
      });
      await resolveOperationalInterruption(
        dependencies,
        currentCheckpointBinding(claim),
      );
      permit.assertActive();

      const successor = await dependencies.turns.activateCommittedSuccessor(turn.turnId);
      await publishTurnProgress(dependencies.progress, successor);
      return successor;
    } catch (error) {
      const reloaded = await recoverAdvanceFailure({
        error,
        turn,
        claim,
        dependencies,
        permit,
      });
      if (!reloaded) {
        const interruption = claim
          ? runtimeInterruption(error, currentCheckpointBinding(claim))
          : isBtccOperationalInterruption(error) ? error : undefined;
        throw interruption ?? error;
      }
      turn = reloaded;
      if (isTerminal(turn)) return turn;
    } finally {
      permit.close();
    }
  }
}

async function recoverAdvanceFailure(input: {
  error: unknown;
  turn: TurnRecord;
  claim?: StateExecutionClaim;
  dependencies: BtccRuntimeDependencies;
  permit: ReturnType<TurnExecutionSupervisor["enter"]>;
}): Promise<TurnRecord | null> {
  const { error, dependencies, permit } = input;
  if (error instanceof LedgerContentionInterruption) {
    try {
      await error.waitForRelease(permit.signal);
    } catch (waitError) {
      const stopped = await findTerminalTurn(dependencies, input.turn.turnId);
      if (stopped) return stopped;
      throw waitError;
    }
    return reloadOwnedTurn(dependencies, input.turn.turnId, error);
  }

  const interruption = input.claim
    ? runtimeInterruption(error, currentCheckpointBinding(input.claim))
    : isBtccOperationalInterruption(error) ? error : undefined;
  if (interruption && dependencies.operationalRecovery) {
    try {
      await waitForOperationalReentry(dependencies, interruption, permit);
    } catch (recoveryError) {
      const stopped = await findTerminalTurn(dependencies, input.turn.turnId);
      if (stopped) return stopped;
      throw recoveryError;
    }
    const turn = await reloadOwnedTurn(dependencies, input.turn.turnId, error);
    return turn;
  }

  const observed = await dependencies.turns.findTurn(input.turn.turnId);
  return observed && isTerminal(observed) ? observed : null;
}

async function reloadOwnedTurn(
  dependencies: BtccRuntimeDependencies,
  turnId: string,
  cause: unknown,
): Promise<TurnRecord> {
  const turn = await dependencies.turns.findTurn(turnId);
  if (!turn) throw new Error("Active BTCC Turn disappeared", { cause });
  return turn;
}

function isTerminal(turn: TurnRecord): boolean {
  return turn.semanticState === "delivered" || turn.semanticState === "cancelled";
}

async function findTerminalTurn(
  dependencies: BtccRuntimeDependencies,
  turnId: string,
): Promise<TurnRecord | null> {
  const turn = await dependencies.turns.findTurn(turnId);
  return turn && isTerminal(turn) ? turn : null;
}
