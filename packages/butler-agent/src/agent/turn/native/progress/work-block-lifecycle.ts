import { publicWorkDecisionPayload } from "../../../output/public-work/decisions.ts";
import type { PublicWorkDecision } from "../output/tool-types.ts";
import { emitTurnEventBestEffort } from "./turn-delivery-events.ts";
import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";

type WorkBlockTerminalStatus = NonNullable<
  PublicWorkDecision["workBlockTerminalStatus"]
>;

export function markWorkBlockTerminal(input: {
  decisions: PublicWorkDecision[];
  workBlockId: string;
  status: WorkBlockTerminalStatus;
}): void {
  for (const decision of input.decisions) {
    if (decision.workBlockId === input.workBlockId) {
      decision.workBlockTerminalStatus = input.status;
    }
  }
}

export async function reconcileOpenWorkBlocks(input: {
  turnInput: RuntimeTurnInput;
  decisions: PublicWorkDecision[];
  status: WorkBlockTerminalStatus;
  beforeProviderRound?: number;
}): Promise<void> {
  const reconciledIds = new Set<string>();
  for (const decision of input.decisions) {
    const workBlockId = decision.workBlockId;
    if (
      !workBlockId ||
      decision.workBlockTerminalStatus ||
      reconciledIds.has(workBlockId)
    ) {
      continue;
    }
    if (
      input.beforeProviderRound !== undefined &&
      (decision.providerRound ?? 0) >= input.beforeProviderRound
    ) {
      continue;
    }
    reconciledIds.add(workBlockId);
    await emitTurnEventBestEffort(input.turnInput, {
      kind: "work.block.completed",
      payload: {
        workBlockId,
        label: decision.blockTitle ?? decision.summary,
        status: input.status,
        ...publicWorkDecisionPayload(decision),
      },
    });
    markWorkBlockTerminal({
      decisions: input.decisions,
      workBlockId,
      status: input.status,
    });
  }
}
