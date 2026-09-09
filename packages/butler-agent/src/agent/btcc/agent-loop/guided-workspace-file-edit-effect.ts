import type {
  EffectAdapterError,
  GuidedEffectRecoveryHint,
} from "../effects/index.ts";
import { prepareOrderedExactEdits } from "../../tools/file-tools/edit_file/index.ts";
import { workspaceFileEffectTarget } from "./guided-workspace-file-target.ts";
import {
  createGuidedWorkspaceFileEditEffectAdapter,
  normalizedGuidedWorkspaceEditCandidate,
  type GuidedWorkspaceFileEditAdapterOptions,
  type GuidedWorkspaceFileEditInput,
  type GuidedWorkspaceFileEditBatch,
  type RegisteredEditFileInvocation,
} from "./guided-workspace-file-edit-adapter.ts";
import { prepareGuidedWorkspaceFileEditBatch } from "./guided-workspace-file-edit-batch-preparation.ts";
import { decodeGuidedWorkspaceFileEditInput } from "./guided-workspace-file-edit-input.ts";
import {
  decodeGuidedWorkspaceUtf8,
  guidedWorkspaceBytesSha256,
  observeGuidedWorkspaceEditTarget,
} from "./guided-workspace-file-edit-observation.ts";
import {
  recoverDurableInput,
  recoverLegacyInput,
} from "./guided-workspace-file-edit-recovery.ts";

export {
  createGuidedWorkspaceFileEditEffectAdapter,
  GUIDED_WORKSPACE_FILE_EDIT_CAPABILITY,
} from "./guided-workspace-file-edit-adapter.ts";
export type {
  GuidedWorkspaceFileEditInput,
  GuidedWorkspaceFileEditResult,
  GuidedWorkspaceFileEditBatch,
  GuidedWorkspaceFileEditBatchResult,
} from "./guided-workspace-file-edit-adapter.ts";

export type PreparedGuidedWorkspaceFileEdit = {
  adapter: ReturnType<typeof createGuidedWorkspaceFileEditEffectAdapter>;
  input: GuidedWorkspaceFileEditInput | GuidedWorkspaceFileEditBatch;
  target: string;
};

export async function prepareGuidedWorkspaceFileEdit(input: {
  args: unknown;
  butlerData?: string;
  executeEditFile(prepared: RegisteredEditFileInvocation): Promise<unknown>;
  priorInputSha256?: string;
  priorRecoveryHint?: GuidedEffectRecoveryHint;
  protectedProjectLedgerRoots?: string[];
  workspacePath: string;
}): Promise<
  | { ok: true; effect: PreparedGuidedWorkspaceFileEdit }
  | { ok: false; error: EffectAdapterError }
> {
  const decoded = decodeGuidedWorkspaceFileEditInput(
    input.args,
    input.workspacePath,
  );
  if (!decoded.ok) return decoded;
  const options: GuidedWorkspaceFileEditAdapterOptions = {
    workspacePath: input.workspacePath,
    butlerData: input.butlerData,
    protectedProjectLedgerRoots: input.protectedProjectLedgerRoots,
    executeEditFile: input.executeEditFile,
  };
  const adapter = createGuidedWorkspaceFileEditEffectAdapter(options);
  if (decoded.value.kind === "batch") {
    return prepareGuidedWorkspaceFileEditBatch({
      adapter,
      args: decoded.value.edits,
      options,
      priorInputSha256: input.priorInputSha256,
      priorRecoveryHint: input.priorRecoveryHint,
    });
  }

  const observed = await observeGuidedWorkspaceEditTarget(
    options,
    decoded.value.path,
  );
  if (!observed.ok) return observed;
  const decodedText = decodeGuidedWorkspaceUtf8(observed.value.bytesValue);
  if (!decodedText.ok) return decodedText;
  if (input.priorInputSha256) {
    const recoveredInput = input.priorRecoveryHint
      ? recoverDurableInput({
          adapter,
          decoded: decoded.value,
          observedText: decodedText.text,
          observedSha256: observed.value.sha256,
          priorInputSha256: input.priorInputSha256,
          priorRecoveryHint: input.priorRecoveryHint,
        })
      : recoverLegacyInput({
          adapter,
          decoded: decoded.value,
          observedText: decodedText.text,
          observedSha256: observed.value.sha256,
          priorInputSha256: input.priorInputSha256,
        });
    if (!recoveredInput) {
      return rejected(
        "edit_file_reconciliation_mismatch",
        "The file no longer matches the durable edit intent; inspect it before continuing.",
      );
    }
    return {
      ok: true,
      effect: {
        adapter,
        input: recoveredInput,
        target: workspaceFileEffectTarget(recoveredInput.path),
      },
    };
  }
  const ordered = prepareOrderedExactEdits([decoded.value], new Map([[decoded.value.path, decodedText.text]]));
  if (!ordered.ok) {
    return rejected(
      ordered.error,
      ordered.error === "old_text_ambiguous"
        ? "The current file contains multiple unresolved old_text occurrences. Provide a more specific exact range."
        : "The current file does not contain old_text; read it again and retry the small edit.",
    );
  }
  const afterText = ordered.files.get(decoded.value.path)!.afterText;
  if (afterText === decodedText.text)
    return rejected(
      "edit_file_no_change",
      "edit_file did not change the file.",
    );
  const selected = normalizedGuidedWorkspaceEditCandidate(
    {
      adapter,
      decoded: {
        path: decoded.value.path,
        oldText: decoded.value.oldText,
        newText: decoded.value.newText,
      },
      location: ordered.locations[0]!,
    },
    {
      beforeSha256: observed.value.sha256,
      afterSha256: textSha256(afterText),
    },
  );
  return {
    ok: true,
    effect: {
      adapter,
      input: selected,
      target: workspaceFileEffectTarget(selected.path),
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
