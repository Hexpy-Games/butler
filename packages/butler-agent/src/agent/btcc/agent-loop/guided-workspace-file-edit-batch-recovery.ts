import { locateExactText } from "../../tools/file-tools/edit_file/index.ts";
import type { GuidedEffectRecoveryHint } from "../effects/index.ts";
import {
  createGuidedWorkspaceFileEditEffectAdapter,
  guidedWorkspaceEditInputSha256,
} from "./guided-workspace-file-edit-adapter.ts";
import {
  isGuidedWorkspaceFileEditBatchInput,
  type DecodedGuidedWorkspaceFileEditEntry,
  type GuidedWorkspaceFileEditBatchInput,
  type GuidedWorkspaceFileEditEntry,
} from "./guided-workspace-file-edit-batch.ts";

export function recoverGuidedWorkspaceFileEditBatch(input: {
  adapter: ReturnType<typeof createGuidedWorkspaceFileEditEffectAdapter>;
  decoded: readonly DecodedGuidedWorkspaceFileEditEntry[];
  observed: readonly {
    decoded: DecodedGuidedWorkspaceFileEditEntry;
    sha256: string;
    text: string;
    identityPath: string;
  }[];
  priorInputSha256: string;
  priorRecoveryHint?: GuidedEffectRecoveryHint;
}): GuidedWorkspaceFileEditBatchInput | null {
  if (
    !input.priorRecoveryHint ||
    input.priorRecoveryHint.capability !== "edit_file" ||
    !isBatchRecoveryHint(input.priorRecoveryHint)
  )
    return null;
  if (input.priorRecoveryHint.entries.length !== input.decoded.length)
    return null;
  const entries: GuidedWorkspaceFileEditEntry[] = [];
  for (const [index, recovery] of input.priorRecoveryHint.entries.entries()) {
    const decoded = input.decoded[index];
    const observed = input.observed[index];
    if (!decoded || !observed || decoded.path !== recovery.path) return null;
    if (observed.sha256 === recovery.beforeSha256) {
      const location = locateExactText({
        text: observed.text,
        oldText: decoded.oldText,
        startLine: recovery.startLine,
      });
      if (!location.ok || location.value.startLine !== recovery.startLine)
        return null;
    } else if (observed.sha256 !== recovery.afterSha256) {
      return null;
    }
    entries.push({
      path: decoded.path,
      start_line: recovery.startLine,
      old_text: decoded.oldText,
      new_text: decoded.newText,
      before_sha256: recovery.beforeSha256,
      after_sha256: recovery.afterSha256,
    });
  }
  let candidate: GuidedWorkspaceFileEditBatchInput;
  try {
    const normalized = input.adapter.normalizeInput({
      edits: entries,
    });
    if (!isGuidedWorkspaceFileEditBatchInput(normalized)) return null;
    candidate = normalized;
  } catch {
    return null;
  }
  return guidedWorkspaceEditInputSha256(candidate) === input.priorInputSha256
    ? candidate
    : null;
}

function isBatchRecoveryHint(
  hint: GuidedEffectRecoveryHint,
): hint is Extract<GuidedEffectRecoveryHint, { entries: readonly unknown[] }> {
  return "entries" in hint;
}
