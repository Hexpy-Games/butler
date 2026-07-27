import type { GoalArtifactPersistence } from "./managed-contracts.ts";

export function decodeUserArtifactTargetRequirement(
  value: unknown,
): GoalArtifactPersistence {
  if (value === "no_user_artifact_target") return "not_required";
  if (value === "reviewed_artifact_bytes_at_admitted_target_required") {
    return "required";
  }
  throw new Error(
    "userArtifactTargetRequirement must name the exact user artifact target requirement",
  );
}
