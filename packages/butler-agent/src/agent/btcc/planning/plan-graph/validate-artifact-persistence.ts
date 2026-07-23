import type { GoalArtifactPersistence } from "../../conception/index.ts";
import type { ManagedArtifactLifecycle } from "../contracts.ts";
import { rejectPlanningProposal } from "./planning-proposal-defect.ts";

export function validateArtifactPersistence(
  requirement: GoalArtifactPersistence,
  lifecycle: Pick<ManagedArtifactLifecycle, "promotionTaskRefs">,
): void {
  const promotionCount = lifecycle.promotionTaskRefs.length;
  if (requirement === "required" && promotionCount === 0) {
    rejectPlanningProposal(
      "artifact_persistence_missing",
      "The accepted Goal requires artifact persistence, but the Plan has no repository promotion",
    );
  }
  if (requirement === "not_required" && promotionCount > 0) {
    rejectPlanningProposal(
      "artifact_persistence_unrequested",
      "The accepted Goal does not require artifact persistence, but the Plan adds repository promotion",
    );
  }
}
