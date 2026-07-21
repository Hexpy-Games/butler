import type { BtccTurnCommand, BtccTurnOutcome } from "../contracts.ts";
import type { TurnExecutionSupervisor } from "../recovery/index.ts";
import type { TurnStateRepository } from "./contracts.ts";

export async function stopTurn(
  command: Extract<BtccTurnCommand, { kind: "stop" }>,
  turns: TurnStateRepository,
  supervisor: TurnExecutionSupervisor,
): Promise<BtccTurnOutcome> {
  supervisor.installStop(command.turnId);
  try {
    const outcome = await turns.stopTurn(command.turnId);
    if (outcome.kind === "already_finalizing") {
      supervisor.allowFinalizing(command.turnId);
    }
    return outcome;
  } catch {
    return { kind: "fenced_pending_persistence", turnId: command.turnId };
  }
}
