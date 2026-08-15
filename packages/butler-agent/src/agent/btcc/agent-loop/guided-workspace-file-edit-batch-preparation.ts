import { locateExactText } from "../../tools/file-tools/edit_file/index.ts";
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
  const actualTargets = new Set<string>();
  let firstError: EffectAdapterError | undefined;
  for (const [index, decoded] of input.args.entries()) {
    const state = await observeGuidedWorkspaceEditTarget(
      input.options,
      decoded.path,
    );
    if (!state.ok) {
      firstError ??= state.error;
      continue;
    }
    if (actualTargets.has(state.value.identityPath)) {
      firstError ??= rejected(
        "edit_file_duplicate_target",
        `edit_file edits[${index}] resolves to a duplicate file.`,
      ).error;
      continue;
    }
    actualTargets.add(state.value.identityPath);
    const decodedText = decodeGuidedWorkspaceUtf8(state.value.bytesValue);
    if (!decodedText.ok) {
      firstError ??= decodedText.error;
      continue;
    }
    observed.push({
      decoded,
      sha256: state.value.sha256,
      text: decodedText.text,
      identityPath: state.value.identityPath,
    });
  }
  if (firstError) return { ok: false, error: firstError };

  if (input.priorInputSha256) {
    const recovered = recoverGuidedWorkspaceFileEditBatch({
      adapter: input.adapter,
      decoded: input.args,
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

  const preparedEntries: GuidedWorkspaceFileEditEntry[] = [];
  for (const state of observed) {
    const location = locateExactText({
      text: state.text,
      oldText: state.decoded.oldText,
      ...(state.decoded.startLine === undefined
        ? {}
        : { startLine: state.decoded.startLine }),
    });
    if (!location.ok) {
      return rejected(
        location.error,
        location.error === "old_text_ambiguous"
          ? "One batch file contains multiple unresolved old_text occurrences."
          : "One batch file does not contain old_text; read every file again and retry.",
      );
    }
    const afterText =
      state.text.slice(0, location.value.offset) +
      state.decoded.newText +
      state.text.slice(location.value.offset + state.decoded.oldText.length);
    if (afterText === state.text)
      return rejected(
        "edit_file_no_change",
        "edit_file batch contains an edit that does not change its file.",
      );
    preparedEntries.push({
      path: state.decoded.path,
      start_line: location.value.startLine,
      old_text: state.decoded.oldText,
      new_text: state.decoded.newText,
      before_sha256: state.sha256,
      after_sha256: textSha256(afterText),
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
