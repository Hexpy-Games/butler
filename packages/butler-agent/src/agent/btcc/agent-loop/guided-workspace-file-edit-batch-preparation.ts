import { prepareOrderedExactEdits } from "../../tools/file-tools/edit_file/index.ts";
import type {
  EffectAdapterError,
  GuidedEffectRecoveryHint,
} from "../effects/index.ts";
import {
  createGuidedWorkspaceFileEditEffectAdapter,
  normalizedGuidedWorkspaceEditBatchCandidate,
  type GuidedWorkspaceFileEditAdapterOptions,
  type GuidedWorkspaceFileEditBatch,
} from "./guided-workspace-file-edit-adapter.ts";
import {
  GUIDED_EDIT_BATCH_MAX,
  GUIDED_EDIT_BATCH_MIN,
  workspaceFileEditBatchTargetForInput,
  type DecodedGuidedWorkspaceFileEditEntry,
  type GuidedWorkspaceFileEditEntry,
} from "./guided-workspace-file-edit-batch.ts";
import {
  decodeGuidedWorkspaceUtf8,
  guidedWorkspaceBytesSha256,
  observeGuidedWorkspaceEditTarget,
} from "./guided-workspace-file-edit-observation.ts";
import { recoverGuidedWorkspaceFileEditBatch } from "./guided-workspace-file-edit-batch-recovery.ts";

export type PreparedGuidedWorkspaceFileEditBatch = {
  adapter: ReturnType<typeof createGuidedWorkspaceFileEditEffectAdapter>;
  input: GuidedWorkspaceFileEditBatch;
  target: string;
};

export async function prepareGuidedWorkspaceFileEditBatch(input: {
  adapter: ReturnType<typeof createGuidedWorkspaceFileEditEffectAdapter>;
  args: readonly DecodedGuidedWorkspaceFileEditEntry[];
  options: GuidedWorkspaceFileEditAdapterOptions;
  priorInputSha256?: string;
  priorRecoveryHint?: GuidedEffectRecoveryHint;
}): Promise<
  | { ok: true; effect: PreparedGuidedWorkspaceFileEditBatch }
  | { ok: false; error: EffectAdapterError }
> {
  if (
    input.args.length < GUIDED_EDIT_BATCH_MIN ||
    input.args.length > GUIDED_EDIT_BATCH_MAX
  ) {
    return rejected(
      "edit_file_invalid_batch",
      `edit_file edits must contain ${GUIDED_EDIT_BATCH_MIN}-${GUIDED_EDIT_BATCH_MAX} entries.`,
    );
  }
  const observed: Array<{
    decoded: DecodedGuidedWorkspaceFileEditEntry;
    sha256: string;
    text: string;
    identityPath: string;
  }> = [];
  const actualTargets = new Map<string, string>();
  let firstError: EffectAdapterError | undefined;
  for (const [index, decoded] of input.args.entries()) {
    const state = await observeGuidedWorkspaceEditTarget(
      input.options,
      decoded.path,
    );
    if (!state.ok) {
      firstError ??= { ...state.error, message: `edits[${index}] (${decoded.path}): ${state.error.message}` };
      continue;
    }
    const canonicalPath = actualTargets.get(state.value.identityPath) ?? decoded.path;
    actualTargets.set(state.value.identityPath, canonicalPath);
    const decodedText = decodeGuidedWorkspaceUtf8(state.value.bytesValue);
    if (!decodedText.ok) {
      firstError ??= { ...decodedText.error, message: `edits[${index}] (${decoded.path}): ${decodedText.error.message}` };
      continue;
    }
    observed.push({
      decoded: { ...decoded, path: canonicalPath },
      sha256: state.value.sha256,
      text: decodedText.text,
      identityPath: state.value.identityPath,
    });
  }
  if (firstError) return { ok: false, error: firstError };

  const unchangedIndex = input.args.findIndex((entry) => entry.oldText === entry.newText);
  if (unchangedIndex >= 0 && !input.priorInputSha256) return rejected("edit_file_no_change", `edits[${unchangedIndex}] (${input.args[unchangedIndex]!.path}) requests no change; no files were written.`);

  if (input.priorInputSha256) {
    const recovered = recoverGuidedWorkspaceFileEditBatch({
      adapter: input.adapter,
      decoded: observed.map((state) => state.decoded),
      observed,
      priorInputSha256: input.priorInputSha256,
      priorRecoveryHint: input.priorRecoveryHint,
    });
    if (!recovered) {
      return rejected(
        "edit_file_reconciliation_mismatch",
        "The files no longer match the durable edit intent; inspect them before continuing.",
      );
    }
    return {
      ok: true,
      effect: {
        adapter: input.adapter,
        input: recovered,
        target: workspaceFileEditBatchTargetForInput(recovered),
      },
    };
  }

  const texts = new Map<string, string>();
  for (const state of observed) if (!texts.has(state.decoded.path)) texts.set(state.decoded.path, state.text);
  const ordered = prepareOrderedExactEdits(observed.map((state) => state.decoded), texts);
  if (!ordered.ok) return rejected(ordered.error, `edits[${ordered.index}] (${ordered.path}): ${ordered.error === "old_text_ambiguous" ? "old_text is ambiguous; provide a more specific exact range." : "old_text was not found in the preceding edit result; inspect this file or correct this edit."}`);
  if ([...ordered.files.values()].every((file) => file.beforeText === file.afterText)) {
    return rejected("edit_file_no_change", "The ordered edits leave every file unchanged; no files were written.");
  }
  const preparedEntries: GuidedWorkspaceFileEditEntry[] = [];
  for (const [index, state] of observed.entries()) {
    const file = ordered.files.get(state.decoded.path)!;
    preparedEntries.push({
      path: state.decoded.path,
      start_line: ordered.locations[index]!.startLine,
      old_text: state.decoded.oldText,
      new_text: state.decoded.newText,
      before_sha256: textSha256(file.beforeText),
      after_sha256: textSha256(file.afterText),
    });
  }
  const normalized = normalizedGuidedWorkspaceEditBatchCandidate({
    adapter: input.adapter,
    entries: preparedEntries,
  });
  return {
    ok: true,
    effect: {
      adapter: input.adapter,
      input: normalized,
      target: workspaceFileEditBatchTargetForInput(normalized),
    },
  };
}

function textSha256(value: string): string {
  return guidedWorkspaceBytesSha256(Buffer.from(value, "utf8"));
}

function rejected(
  code: string,
  message: string,
): { ok: false; error: EffectAdapterError } {
  return { ok: false, error: { code, message } };
}
