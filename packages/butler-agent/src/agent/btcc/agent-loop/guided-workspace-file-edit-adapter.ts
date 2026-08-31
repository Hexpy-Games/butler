import {
  type EffectAdapter,
  type EffectAdapterError,
  type EffectDispatchOutcome,
  type EffectReconciliation,
  type GuidedEffectRecoveryHint,
} from "../effects/index.ts";
import {
  normalizeWorkspaceFileTarget,
  workspaceFileEffectTarget,
} from "./guided-workspace-file-target.ts";
import {
  dispatchGuidedWorkspaceEditBatch,
  reconcileGuidedWorkspaceEditBatch,
} from "./guided-workspace-file-edit-batch-adapter.ts";
import { classifyGuidedWorkspaceEditBlocker } from "./guided-workspace-file-edit-blocker.ts";
import { observeGuidedWorkspaceEditTarget } from "./guided-workspace-file-edit-observation.ts";
import {
  isGuidedWorkspaceFileEditBatchInput,
  normalizeWorkspaceFileEditBatchTarget,
  type GuidedWorkspaceFileEditNormalizedInput,
} from "./guided-workspace-file-edit-batch.ts";
import { normalizeGuidedWorkspaceFileEditEffectInput } from "./guided-workspace-file-edit-normalization.ts";
import {
  GUIDED_WORKSPACE_FILE_EDIT_CAPABILITY,
  type GuidedWorkspaceFileEditAdapterOptions,
  type GuidedWorkspaceFileEditBatchResult,
  type GuidedWorkspaceFileEditInput,
  type GuidedWorkspaceFileEditResult,
} from "./guided-workspace-file-edit-contracts.ts";
import type { ChangedFileDetail } from "../../tools/file-tools/shared/changed-file-detail.ts";

export {
  GUIDED_WORKSPACE_FILE_EDIT_CAPABILITY,
} from "./guided-workspace-file-edit-contracts.ts";
export type {
  GuidedWorkspaceFileEditAdapterOptions,
  GuidedWorkspaceFileEditBatch,
  GuidedWorkspaceFileEditBatchResult,
  GuidedWorkspaceFileEditInput,
  GuidedWorkspaceFileEditResult,
  RegisteredEditFileBatchInput,
  RegisteredEditFileInput,
  RegisteredEditFileInvocation,
} from "./guided-workspace-file-edit-contracts.ts";
export {
  guidedWorkspaceEditInputSha256,
  normalizedGuidedWorkspaceEditBatchCandidate,
  normalizedGuidedWorkspaceEditCandidate,
} from "./guided-workspace-file-edit-normalization.ts";

export function createGuidedWorkspaceFileEditEffectAdapter(
  options: GuidedWorkspaceFileEditAdapterOptions,
): EffectAdapter<
  GuidedWorkspaceFileEditNormalizedInput,
  GuidedWorkspaceFileEditResult | GuidedWorkspaceFileEditBatchResult
> {
  return {
    capability: GUIDED_WORKSPACE_FILE_EDIT_CAPABILITY,
    reviewedPlanBinding: "accepted_plan",
    normalizeTarget(target) {
      return target.startsWith("workspace:batch:")
        ? normalizeWorkspaceFileEditBatchTarget(target)
        : normalizeWorkspaceFileTarget(target);
    },
    sanitizeTarget: (target) => target,
    normalizeInput: (input) =>
      normalizeGuidedWorkspaceFileEditEffectInput(input, options.workspacePath),
    recoveryHint(input): GuidedEffectRecoveryHint {
      if (isGuidedWorkspaceFileEditBatchInput(input)) {
        return {
          capability: GUIDED_WORKSPACE_FILE_EDIT_CAPABILITY,
          entries: input.edits.map((entry) => ({
            path: entry.path,
            startLine: entry.start_line,
            beforeSha256: entry.before_sha256,
            afterSha256: entry.after_sha256,
          })),
        };
      }
      return {
        capability: GUIDED_WORKSPACE_FILE_EDIT_CAPABILITY,
        startLine: input.start_line,
        beforeSha256: input.before_sha256,
        afterSha256: input.after_sha256,
      };
    },
    async dispatch(input) {
      if (isGuidedWorkspaceFileEditBatchInput(input.normalizedInput)) {
        return dispatchGuidedWorkspaceEditBatch(options, {
          normalizedTarget: input.normalizedTarget,
          normalizedInput: input.normalizedInput,
          signal: input.signal,
        });
      }
      const mismatch = targetInputMismatch(
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
      const before = await observeGuidedWorkspaceEditTarget(
        options,
        input.normalizedInput.path,
      );
      if (!before.ok) return notApplied(before.error);
      if (before.value.sha256 !== input.normalizedInput.before_sha256) {
        return notApplied({
          code: "expected_sha256_mismatch",
          message:
            "The workspace file changed before the reviewed edit was applied.",
        });
      }
      const registeredResult = await options.executeEditFile({
        path: input.normalizedInput.path,
        start_line: input.normalizedInput.start_line,
        old_text: input.normalizedInput.old_text,
        new_text: input.normalizedInput.new_text,
        expected_sha256: input.normalizedInput.before_sha256,
      });
      const after = await observeGuidedWorkspaceEditTarget(
        options,
        input.normalizedInput.path,
      );
      if (
        after.ok &&
        after.value.sha256 === input.normalizedInput.after_sha256
      ) {
        return applied(
          input.normalizedInput,
          after.value.bytes,
          changedFileFromRegisteredResult(registeredResult),
        );
      }
      const rejection = registeredToolRejection(registeredResult);
      if (rejection) return notApplied(rejection);
      return uncertain(after.ok ? stateMismatch() : after.error);
    },
    async reconcile(input) {
      if (isGuidedWorkspaceFileEditBatchInput(input.normalizedInput)) {
        return reconcileGuidedWorkspaceEditBatch(options, {
          normalizedTarget: input.normalizedTarget,
          normalizedInput: input.normalizedInput,
          dispatchAttempts: input.dispatchAttempts,
          priorError: input.priorError,
        });
      }
      const mismatch = targetInputMismatch(
        input.normalizedTarget,
        input.normalizedInput,
      );
      if (mismatch) return { status: "uncertain", error: mismatch };
      const observation = await observeGuidedWorkspaceEditTarget(
        options,
        input.normalizedInput.path,
      );
      if (!observation.ok)
        return { status: "uncertain", error: observation.error };
      if (observation.value.sha256 === input.normalizedInput.before_sha256) {
        return { status: "not_applied" };
      }
      if (
        observation.value.sha256 === input.normalizedInput.after_sha256 &&
        input.dispatchAttempts > 0
      ) {
        return applied(input.normalizedInput, observation.value.bytes);
      }
      if (
        observation.value.sha256 === input.normalizedInput.after_sha256 &&
        input.dispatchAttempts === 0
      ) {
        return { status: "not_applied" };
      }
      return { status: "uncertain", error: stateMismatch() };
    },
    async classifyEffectBlocker(input) {
      return classifyGuidedWorkspaceEditBlocker({
        ...input,
        normalizeInput: (value) =>
          normalizeGuidedWorkspaceFileEditEffectInput(value, options.workspacePath),
      });
    },
  };
}

function applied(
  input: GuidedWorkspaceFileEditInput,
  bytes: number,
  changedFile?: ChangedFileDetail,
): EffectDispatchOutcome<GuidedWorkspaceFileEditResult> &
  EffectReconciliation<GuidedWorkspaceFileEditResult> {
  return {
    status: "applied",
    result: {
      ok: true,
      effect: "workspace_file_edit",
      path: input.path,
      start_line: input.start_line,
      bytes,
      before_sha256: input.before_sha256,
      after_sha256: input.after_sha256,
      target_observed: true,
      ...(changedFile ? { changed_file: changedFile } : {}),
    },
  };
}

function changedFileFromRegisteredResult(value: unknown): ChangedFileDetail | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const detail = (value as Record<string, unknown>).changed_file;
  return detail && typeof detail === "object" && !Array.isArray(detail)
    ? detail as ChangedFileDetail
    : undefined;
}

function targetInputMismatch(
  target: string,
  input: GuidedWorkspaceFileEditInput,
): EffectAdapterError | null {
  return target === workspaceFileEffectTarget(input.path)
    ? null
    : {
        code: "workspace_target_input_mismatch",
        message:
          "The reviewed edit target does not match the normalized input path.",
      };
}

function notApplied<
  TResult = GuidedWorkspaceFileEditResult | GuidedWorkspaceFileEditBatchResult,
>(error: EffectAdapterError): EffectDispatchOutcome<TResult> {
  return { status: "not_applied", error };
}

function uncertain<
  TResult = GuidedWorkspaceFileEditResult | GuidedWorkspaceFileEditBatchResult,
>(error: EffectAdapterError): EffectDispatchOutcome<TResult> {
  return { status: "uncertain", error };
}

function registeredToolRejection(value: unknown): EffectAdapterError | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.ok !== false) return null;
  const code =
    typeof record.error === "string"
      ? record.error
      : "registered_edit_file_rejected";
  return {
    code,
    message: `The registered edit_file tool rejected the reviewed edit (${code}).`,
  };
}

function stateMismatch(): EffectAdapterError {
  return {
    code: "workspace_file_state_mismatch",
    message:
      "The workspace file matches neither the durable before nor after state.",
  };
}
