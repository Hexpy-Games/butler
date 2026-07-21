import { createHash } from "node:crypto";
import type { BtccTurnCommand } from "../../contracts.ts";
import type {
  TurnAdmissionRepository,
  TurnRecord,
  TurnStateRepository,
} from "../contracts.ts";

export async function admitTurn(
  command: Extract<BtccTurnCommand, { kind: "run" }>,
  admission: TurnAdmissionRepository,
  turns: TurnStateRepository,
): Promise<TurnRecord> {
  const admissionInputHash = digest(JSON.stringify({
    turnId: command.turnId,
    sessionId: command.sessionId,
    triggerKey: command.triggerKey,
    message: command.message,
    modelSelection: command.modelSelection,
    context: command.context,
  }));
  const inbox = await admission.recordInbound({ command, admissionInputHash });
  if (inbox.status === "constructed") {
    const existing = await turns.findTurn(inbox.turnId);
    if (!existing) throw new Error("Constructed BTCC Inbox has no Turn");
    return existing;
  }
  const claim = await admission.acquireAdmissionConstructionClaim(inbox);
  return admission.constructTurn(inbox, claim);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
