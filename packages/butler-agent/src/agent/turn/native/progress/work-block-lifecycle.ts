import { publicWorkDecisionPayload } from "../../../output/public-work/decisions.ts";
import type { PublicWorkDecision } from "../output/tool-types.ts";
import { emitTurnEventBestEffort } from "./turn-delivery-events.ts";
import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";

type WorkBlockTerminalStatus = NonNullable<
  PublicWorkDecision["workBlockTerminalStatus"]
>;

export function markWorkBlockFailure(input: {
  decisions: PublicWorkDecision[];
  workBlockId: string;
}): void {
  for (const decision of input.decisions) {
    if (decision.workBlockId === input.workBlockId) {
      decision.workBlockHasFailure = true;
    }
  }
}

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
    const status =
      input.status === "completed" && decision.workBlockHasFailure
        ? "failed"
        : input.status;
    await emitTurnEventBestEffort(input.turnInput, {
      kind: "work.block.completed",
      payload: {
        workBlockId,
        label: decision.blockTitle ?? decision.summary,
        status,
        ...publicWorkDecisionPayload(decision),
      },
    });
    markWorkBlockTerminal({
      decisions: input.decisions,
      workBlockId,
      status,
    });
  }
}
