import { stableEffectJson } from "../effects/index.ts";
import {
  batchEntries,
  isGuidedWorkspaceFileEditBatchInput,
  normalizeWorkspaceFileEditBatchTarget,
  workspaceFileEditBatchTarget,
  type GuidedWorkspaceFileEditNormalizedInput,
} from "./guided-workspace-file-edit-batch.ts";
import { GUIDED_WORKSPACE_FILE_EDIT_CAPABILITY } from "./guided-workspace-file-edit-contracts.ts";
import { workspaceFileEffectTarget } from "./guided-workspace-file-target.ts";

export async function classifyGuidedWorkspaceEditBlocker(input: {
  blockerCapability: string;
  blockerTarget: string;
  blockerInput: Record<string, unknown>;
  normalizedTarget: string;
  normalizedInput: GuidedWorkspaceFileEditNormalizedInput;
  normalizeInput(value: unknown): GuidedWorkspaceFileEditNormalizedInput;
}): Promise<"unrelated" | "overlapping" | "equivalent" | "ambiguous"> {
  if (input.blockerCapability !== GUIDED_WORKSPACE_FILE_EDIT_CAPABILITY) {
    return "unrelated";
  }
  try {
    if (!targetMatchesInput(input.normalizedTarget, input.normalizedInput)) {
      return "ambiguous";
    }
    const currentEntries = batchEntries(input.normalizedInput);
    const prior = input.normalizeInput(input.blockerInput);
    if (!targetMatchesInput(input.blockerTarget, prior)) return "ambiguous";
    const priorEntries = batchEntries(prior);
    if (stableEffectJson(prior) === stableEffectJson(input.normalizedInput)) {
      return "equivalent";
    }
    const currentPaths = new Set(currentEntries.map((entry) => entry.path));
    return priorEntries.some((entry) => currentPaths.has(entry.path))
      ? "overlapping"
      : "unrelated";
  } catch {
    return "ambiguous";
  }
}

function targetMatchesInput(
  target: string,
  input: GuidedWorkspaceFileEditNormalizedInput,
): boolean {
  if (isGuidedWorkspaceFileEditBatchInput(input)) {
    try {
      return (
        normalizeWorkspaceFileEditBatchTarget(target) ===
        workspaceFileEditBatchTarget(input)
      );
    } catch {
      return false;
    }
  }
  return target === workspaceFileEffectTarget(input.path);
}
