import type { WorkStreamResumeCheckpoint } from "./workstream-checkpoint-resume-types.ts";

const WORKSPACE_PHASES = new Set([
  "execution",
  "review",
  "consolidation",
  "reporting",
]);

export function checkpointNeedsWorkspaceProfile(checkpoint: WorkStreamResumeCheckpoint): boolean {
  if (phaseNeedsWorkspace(checkpoint.currentPhase)) return true;
  if (Object.keys(checkpoint.openItemPhaseCounts ?? {}).some(phaseNeedsWorkspace)) return true;
  return checkpoint.activeItems.some((item) => phaseNeedsWorkspace(item.phase));
}

function phaseNeedsWorkspace(phase: string | null | undefined): boolean {
  return typeof phase === "string" && WORKSPACE_PHASES.has(phase);
}
