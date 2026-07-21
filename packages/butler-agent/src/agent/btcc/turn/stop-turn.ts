import type { BtccTurnCommand, BtccTurnOutcome } from "../contracts.ts";

export async function stopTurn(
  _command: Extract<BtccTurnCommand, { kind: "stop" }>,
): Promise<BtccTurnOutcome> {
  throw new Error("BTCC Stop is not implemented");
}
