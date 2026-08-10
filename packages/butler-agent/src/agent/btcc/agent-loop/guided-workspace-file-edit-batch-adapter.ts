import {
  type EffectAdapterError,
  type EffectDispatchOutcome,
  type EffectReconciliation,
  type GuidedEffectError,
} from "../effects/index.ts";
import { type GuidedWorkspaceFileEditBatchInput } from "./guided-workspace-file-edit-batch.ts";
import {
  observeGuidedWorkspaceEditTarget,
  type GuidedWorkspaceEditGuardOptions,
} from "./guided-workspace-file-edit-observation.ts";
import {
  type GuidedWorkspaceFileEditBatchResult,
  type RegisteredEditFileInvocation,
} from "./guided-workspace-file-edit-contracts.ts";
import { workspaceFileEditBatchTarget } from "./guided-workspace-file-edit-batch.ts";

export type GuidedWorkspaceFileEditBatchAdapterOptions =
  GuidedWorkspaceEditGuardOptions & {
    executeEditFile(input: RegisteredEditFileInvocation): Promise<unknown>;
  };

export async function dispatchGuidedWorkspaceEditBatch(
  options: GuidedWorkspaceFileEditBatchAdapterOptions,
  input: {
    normalizedTarget: string;
    normalizedInput: GuidedWorkspaceFileEditBatchInput;
    signal: AbortSignal;
  },
): Promise<EffectDispatchOutcome<GuidedWorkspaceFileEditBatchResult>> {
  const mismatch = batchTargetInputMismatch(
    input.normalizedTarget,
    input.normalizedInput,
  );
  if (mismatch) return notApplied(mismatch);
  if (input.signal.aborted) {
    return notApplied({
      code: "edit_file_cancelled",
      message: "edit_file was cancelled before registered tool dispatch.",
    });
  }

  const beforeStates = await observeBatchStates(options, input.normalizedInput);
  if (beforeStates.error) return notApplied(beforeStates.error);
  if (
    !beforeStates.states.every(
      (state, index) =>
        state.sha256 === input.normalizedInput.edits[index]!.before_sha256,
    )
  ) {
    return notApplied({
      code: "expected_sha256_mismatch",
      message:
        "One or more workspace files changed before the reviewed batch was applied.",
    });
  }

  const registeredResult = await options.executeEditFile({
    edits: input.normalizedInput.edits.map((entry) => ({
      path: entry.path,
      start_line: entry.start_line,
      old_text: entry.old_text,
      new_text: entry.new_text,
      expected_sha256: entry.before_sha256,
    })),
  });
  const afterStates = await observeBatchStates(options, input.normalizedInput);
  if (isRegisteredPartialApply(registeredResult)) {
    return uncertain({
      code: "partial_apply",
      message:
        "The registered edit_file batch reported partial application; inspect every file before retrying.",
    });
  }
  if (afterStates.error) return uncertain(afterStates.error);
  const afterMatches = afterStates.states.every(
    (state, index) =>
      state.sha256 === input.normalizedInput.edits[index]!.after_sha256,
  );
  if (afterMatches)
    return appliedBatch(input.normalizedInput, afterStates.states);
  const beforeMatches = afterStates.states.every(
    (state, index) =>
      state.sha256 === input.normalizedInput.edits[index]!.before_sha256,
  );
  const rejection = registeredToolRejection(registeredResult);
  if (beforeMatches && rejection) return notApplied(rejection);
  if (beforeMatches) {
    return notApplied({
      code: "registered_edit_file_rejected",
      message: "The registered edit_file batch did not change any target.",
    });
  }
  return uncertain(stateMismatch());
}

export async function reconcileGuidedWorkspaceEditBatch(
  options: GuidedWorkspaceFileEditBatchAdapterOptions,
  input: {
    normalizedTarget: string;
    normalizedInput: GuidedWorkspaceFileEditBatchInput;
    dispatchAttempts: number;
    priorError?: GuidedEffectError;
  },
): Promise<EffectReconciliation<GuidedWorkspaceFileEditBatchResult>> {
  const mismatch = batchTargetInputMismatch(
    input.normalizedTarget,
    input.normalizedInput,
  );
  if (mismatch) return { status: "uncertain", error: mismatch };
  const priorSourceCode = input.priorError?.sourceCode;
  const observed = await observeBatchStates(options, input.normalizedInput);
  if (observed.error) return { status: "uncertain", error: observed.error };
  const allBefore = observed.states.every(
    (state, index) =>
      state.sha256 === input.normalizedInput.edits[index]!.before_sha256,
  );
  if (allBefore) {
    if (
      priorSourceCode === "partial_apply" ||
      priorSourceCode === "workspace_file_state_mismatch"
    ) {
      return {
        status: "uncertain",
        error: {
          code: priorSourceCode,
          message:
            "A prior registered batch left an uncertain file set; automatic replay is disabled.",
        },
      };
    }
    return { status: "not_applied" };
  }
  const allAfter = observed.states.every(
    (state, index) =>
      state.sha256 === input.normalizedInput.edits[index]!.after_sha256,
  );
  if (allAfter) {
    return input.dispatchAttempts > 0
      ? appliedBatch(input.normalizedInput, observed.states)
      : { status: "not_applied" };
  }
  if (
    priorSourceCode === "partial_apply" ||
    priorSourceCode === "workspace_file_state_mismatch"
  ) {
    return {
      status: "uncertain",
      error: {
        code: priorSourceCode,
        message:
          "A prior registered batch left an uncertain file set; automatic replay is disabled.",
      },
    };
  }
  return { status: "uncertain", error: stateMismatch() };
}

async function observeBatchStates(
  options: GuidedWorkspaceFileEditBatchAdapterOptions,
  input: GuidedWorkspaceFileEditBatchInput,
): Promise<{
  states: Array<{ bytes: number; sha256: string }>;
  error?: EffectAdapterError;
}> {
  const states: Array<{ bytes: number; sha256: string }> = [];
  let firstError: EffectAdapterError | undefined;
  for (const entry of input.edits) {
    const observed = await observeGuidedWorkspaceEditTarget(
      options,
      entry.path,
    );
    if (!observed.ok) {
      firstError ??= observed.error;
      continue;
    }
    states.push({ bytes: observed.value.bytes, sha256: observed.value.sha256 });
  }
  return firstError ? { states, error: firstError } : { states };
}

function appliedBatch(
  input: GuidedWorkspaceFileEditBatchInput,
  states: readonly { bytes: number; sha256: string }[],
): Extract<
  EffectDispatchOutcome<GuidedWorkspaceFileEditBatchResult>,
  { status: "applied" }
> {
  const entries = input.edits.map((entry, index) => ({
    index,
    start_line: entry.start_line,
    bytes: states[index]?.bytes ?? 0,
    before_sha256: entry.before_sha256,
    after_sha256: entry.after_sha256,
  }));
  return {
    status: "applied",
    result: {
      ok: true,
      effect: "workspace_file_edit_batch",
      files: entries.length,
      bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
      entries,
      target_observed: true,
    },
  };
}

function batchTargetInputMismatch(
  target: string,
  input: GuidedWorkspaceFileEditBatchInput,
): EffectAdapterError | null {
  return workspaceFileEditBatchTarget(input) === target
    ? null
    : {
        code: "workspace_target_input_mismatch",
        message:
          "The reviewed edit batch target does not match its normalized file set.",
      };
}

function isRegisteredPartialApply(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.ok === false && record.error === "partial_apply";
}

function registeredToolRejection(value: unknown): EffectAdapterError | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.ok !== false) return null;
  return {
    code:
      typeof record.error === "string"
        ? record.error
        : "registered_edit_file_rejected",
    message: "The registered edit_file tool rejected the reviewed batch.",
  };
}

function stateMismatch(): EffectAdapterError {
  return {
    code: "workspace_file_state_mismatch",
    message:
      "One or more workspace files match neither the durable before nor after state.",
  };
}

function notApplied<TResult = GuidedWorkspaceFileEditBatchResult>(
  error: EffectAdapterError,
): EffectDispatchOutcome<TResult> {
  return { status: "not_applied", error };
}

function uncertain<TResult = GuidedWorkspaceFileEditBatchResult>(
  error: EffectAdapterError,
): EffectDispatchOutcome<TResult> {
  return { status: "uncertain", error };
}
