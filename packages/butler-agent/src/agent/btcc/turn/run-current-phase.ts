import { conception } from "../conception/index.ts";
import { consolidation } from "../consolidation/index.ts";
import type { BtccRuntimeDependencies } from "../contracts.ts";
import type { ProviderCorrection } from "../core/index.ts";
import { insertCanonicalMessage } from "../delivery/index.ts";
import { execution } from "../execution/index.ts";
import { planning } from "../planning/index.ts";
import { reporting } from "../reporting/index.ts";
import type { ExecutionPermit } from "../recovery/index.ts";
import { review } from "../review/index.ts";
import { work } from "../work/index.ts";
import { createPhaseInvocation } from "./create-phase-invocation.ts";
import type {
  StateExecutionClaim,
  TurnEvent,
  TurnRecord,
} from "./contracts.ts";

export async function runCurrentPhase(input: {
  turn: TurnRecord;
  claim: StateExecutionClaim;
  dependencies: BtccRuntimeDependencies;
  executionPermit: ExecutionPermit;
  providerCorrection?: ProviderCorrection;
}): Promise<TurnEvent> {
  const { turn, dependencies } = input;
  const phase = () => createPhaseInvocation(
    turn,
    input.claim,
    dependencies,
    input.executionPermit,
    input.providerCorrection,
  );

  switch (turn.semanticState) {
    case "admitted":
      return { kind: "TurnActivated" };

    case "conception_opening":
    case "assisted_answer":
    case "conception_deliberation":
    case "contract_review":
      return conception({ cycle: "initial", turn, phase: phase() });

    case "planning":
    case "planning_review":
      return planning({ cycle: "initial", turn, phase: phase() });

    case "work_frontier":
      return work({ turn, artifacts: dependencies.artifacts });

    case "task_execution":
      return execution({ turn, phase: phase() });

    case "task_review":
      return review({ turn, phase: phase() });

    case "feedback_conception":
      return conception({ cycle: "review_feedback", turn, phase: phase() });

    case "feedback_planning":
    case "feedback_planning_review":
      return planning({ cycle: "review_feedback", turn, phase: phase() });

    case "consolidation":
      return consolidation({ turn, phase: phase() });

    case "reporting":
      return reporting({ turn, phase: phase() });

    case "delivery_committed": {
      const message = await insertCanonicalMessage({
        turn,
        messages: dependencies.messages,
      });
      return {
        kind: "DeliveryObserved",
        assistantMessageId: message.messageId,
      };
    }

    case "delivered":
    case "cancelled":
      throw new Error(`Terminal BTCC state cannot be advanced: ${turn.semanticState}`);
  }
}
