import type { EffectAdapterError } from "../../btcc/effects/index.ts";
import {
  normalizeWorkspaceContainedPath,
  workspaceFileEffectTarget,
} from "./guided-workspace-file-target.ts";
import {
  createGuidedWorkspaceFileEditEffectAdapter,
  guidedWorkspaceEditInputSha256,
  type GuidedWorkspaceFileEditAdapterOptions,
  type GuidedWorkspaceFileEditInput,
  type RegisteredEditFileInput,
} from "./guided-workspace-file-edit-adapter.ts";
import {
  decodeGuidedWorkspaceUtf8,
  guidedWorkspaceBytesSha256,
  observeGuidedWorkspaceEditTarget,
} from "./guided-workspace-file-edit-observation.ts";

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
  const offset = lineStartOffset(decodedText.text, decoded.value.startLine);
  if (offset === null) {
    return rejected(
      "start_line_out_of_range",
      "edit_file start_line is outside the current file.",
    );
  }

  const adapter = createGuidedWorkspaceFileEditEffectAdapter(options);
  const candidates = effectCandidates({
    adapter,
    decoded: decoded.value,
    observedText: decodedText.text,
    observedSha256: observed.value.sha256,
    offset,
    includeAfterState: Boolean(input.priorInputSha256),
  });
  if (!candidates.ok) return candidates;
  const selected = input.priorInputSha256
    ? candidates.values.find((candidate) =>
        guidedWorkspaceEditInputSha256(candidate) === input.priorInputSha256,
      )
    : candidates.values[0];
  if (!selected) {
    return rejected(
      input.priorInputSha256
        ? "edit_file_reconciliation_mismatch"
        : "old_text_mismatch",
      input.priorInputSha256
        ? "The file no longer matches the durable edit intent; inspect it before continuing."
        : "The current file does not contain old_text at start_line; read it again and retry the small edit.",
    );
  }
  return {
    ok: true,
    effect: {
      adapter,
      input: selected,
      target: workspaceFileEffectTarget(selected.path),
    },
  };
}

function effectCandidates(input: {
  adapter: ReturnType<typeof createGuidedWorkspaceFileEditEffectAdapter>;
  decoded: DecodedEditInput;
  observedText: string;
  observedSha256: string;
  offset: number;
  includeAfterState: boolean;
}):
  | { ok: true; values: GuidedWorkspaceFileEditInput[] }
  | { ok: false; error: EffectAdapterError } {
  const values: GuidedWorkspaceFileEditInput[] = [];
  if (input.observedText.startsWith(input.decoded.oldText, input.offset)) {
    const afterText = input.observedText.slice(0, input.offset) +
      input.decoded.newText +
      input.observedText.slice(input.offset + input.decoded.oldText.length);
    if (afterText === input.observedText) {
      return rejected("edit_file_no_change", "edit_file did not change the file.");
    }
    values.push(normalizedCandidate(input, {
      beforeSha256: input.observedSha256,
      afterSha256: textSha256(afterText),
    }));
  }
  if (
    input.includeAfterState &&
    input.observedText.startsWith(input.decoded.newText, input.offset)
  ) {
    const reconstructedBefore = input.observedText.slice(0, input.offset) +
      input.decoded.oldText +
      input.observedText.slice(input.offset + input.decoded.newText.length);
    values.push(normalizedCandidate(input, {
      beforeSha256: textSha256(reconstructedBefore),
      afterSha256: input.observedSha256,
    }));
  }
  return { ok: true, values };
}

function normalizedCandidate(
  input: {
    adapter: ReturnType<typeof createGuidedWorkspaceFileEditEffectAdapter>;
    decoded: DecodedEditInput;
  },
  hashes: { beforeSha256: string; afterSha256: string },
): GuidedWorkspaceFileEditInput {
  return input.adapter.normalizeInput({
    path: input.decoded.path,
    start_line: input.decoded.startLine,
    old_text: input.decoded.oldText,
    new_text: input.decoded.newText,
    before_sha256: hashes.beforeSha256,
    after_sha256: hashes.afterSha256,
  });
}

type DecodedEditInput = {
  path: string;
  startLine: number;
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
  if (!Number.isSafeInteger(record.start_line) || Number(record.start_line) < 1) {
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
        startLine: Number(record.start_line),
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

function lineStartOffset(content: string, startLine: number): number | null {
  if (startLine === 1) return content.startsWith("\uFEFF") ? 1 : 0;
  let line = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "\n") continue;
    line += 1;
    if (line === startLine) return index + 1;
  }
  return null;
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
