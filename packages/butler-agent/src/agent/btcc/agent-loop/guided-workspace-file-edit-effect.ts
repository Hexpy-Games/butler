import type {
  EffectAdapterError,
  GuidedEffectRecoveryHint,
} from "../effects/index.ts";
import {
  locateExactText,
} from "../../tools/file-tools/edit_file/index.ts";
import {
  normalizeWorkspaceContainedPath,
  workspaceFileEffectTarget,
} from "./guided-workspace-file-target.ts";
import {
  createGuidedWorkspaceFileEditEffectAdapter,
  normalizedGuidedWorkspaceEditCandidate,
  type GuidedWorkspaceFileEditAdapterOptions,
  type GuidedWorkspaceFileEditInput,
  type RegisteredEditFileInput,
} from "./guided-workspace-file-edit-adapter.ts";
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
} from "./guided-workspace-file-edit-adapter.ts";

export type PreparedGuidedWorkspaceFileEdit = {
  adapter: ReturnType<typeof createGuidedWorkspaceFileEditEffectAdapter>;
  input: GuidedWorkspaceFileEditInput;
  target: string;
};

export async function prepareGuidedWorkspaceFileEdit(input: {
  args: unknown;
  butlerData?: string;
  executeEditFile(prepared: RegisteredEditFileInput): Promise<unknown>;
  priorInputSha256?: string;
  priorRecoveryHint?: GuidedEffectRecoveryHint;
  protectedProjectLedgerRoots?: string[];
  workspacePath: string;
}): Promise<
  | { ok: true; effect: PreparedGuidedWorkspaceFileEdit }
  | { ok: false; error: EffectAdapterError }
> {
  const decoded = decodeEditInput(input.args, input.workspacePath);
  if (!decoded.ok) return decoded;
  const options: GuidedWorkspaceFileEditAdapterOptions = {
    workspacePath: input.workspacePath,
    butlerData: input.butlerData,
    protectedProjectLedgerRoots: input.protectedProjectLedgerRoots,
    executeEditFile: input.executeEditFile,
  };
  const observed = await observeGuidedWorkspaceEditTarget(
    options,
    decoded.value.path,
  );
  if (!observed.ok) return observed;
  const decodedText = decodeGuidedWorkspaceUtf8(observed.value.bytesValue);
  if (!decodedText.ok) return decodedText;

  const adapter = createGuidedWorkspaceFileEditEffectAdapter(options);
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
  const location = locateExactText({
    text: decodedText.text,
    oldText: decoded.value.oldText,
    ...(decoded.value.startLine === undefined
      ? {}
      : { startLine: decoded.value.startLine }),
  });
  if (!location.ok) {
    return rejected(
      location.error,
      location.error === "old_text_ambiguous"
        ? "The current file contains multiple unresolved old_text occurrences. Provide a more specific exact range."
        : input.priorInputSha256
          ? "The file no longer matches the durable edit intent; inspect it before continuing."
          : "The current file does not contain old_text; read it again and retry the small edit.",
    );
  }
  const afterText = decodedText.text.slice(0, location.value.offset) +
    decoded.value.newText +
    decodedText.text.slice(location.value.offset + decoded.value.oldText.length);
  if (afterText === decodedText.text) {
    return rejected("edit_file_no_change", "edit_file did not change the file.");
  }
  const selected = normalizedGuidedWorkspaceEditCandidate({
    adapter,
    decoded: decoded.value,
    location: location.value,
  }, {
    beforeSha256: observed.value.sha256,
    afterSha256: textSha256(afterText),
  });
  return {
    ok: true,
    effect: {
      adapter,
      input: selected,
      target: workspaceFileEffectTarget(selected.path),
    },
  };
}

type DecodedEditInput = {
  path: string;
  startLine?: number;
  oldText: string;
  newText: string;
};

function decodeEditInput(
  input: unknown,
  workspacePath: string,
): { ok: true; value: DecodedEditInput } | { ok: false; error: EffectAdapterError } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return rejected("edit_file_invalid_input", "edit_file input must be an object.");
  }
  const record = input as Record<string, unknown>;
  if (typeof record.old_text !== "string" || record.old_text.length === 0) {
    return rejected(
      "edit_file_invalid_old_text",
      "edit_file requires non-empty old_text copied from the current file.",
    );
  }
  if (typeof record.new_text !== "string") {
    return rejected("edit_file_invalid_new_text", "edit_file requires string new_text.");
  }
  if (
    record.start_line !== undefined &&
    (!Number.isSafeInteger(record.start_line) || Number(record.start_line) < 1)
  ) {
    return rejected(
      "edit_file_invalid_start_line",
      "edit_file start_line must be a positive integer.",
    );
  }
  try {
    return {
      ok: true,
      value: {
        path: normalizeWorkspaceContainedPath(
          workspacePath,
          requiredText(record.path, "path"),
        ),
        ...(record.start_line === undefined
          ? {}
          : { startLine: Number(record.start_line) }),
        oldText: record.old_text,
        newText: record.new_text,
      },
    };
  } catch {
    return rejected(
      "edit_file_invalid_path",
      "edit_file path must identify one file inside the admitted workspace.",
    );
  }
}

function textSha256(value: string): string {
  return guidedWorkspaceBytesSha256(Buffer.from(value, "utf8"));
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`edit_file requires ${field}`);
  }
  return value.trim();
}

function rejected(
  code: string,
  message: string,
): { ok: false; error: EffectAdapterError } {
  return { ok: false, error: { code, message } };
}
