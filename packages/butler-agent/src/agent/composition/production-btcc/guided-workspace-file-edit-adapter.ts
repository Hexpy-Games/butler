import {
  stableEffectJson,
  type EffectAdapter,
  type EffectAdapterError,
  type EffectDispatchOutcome,
  type EffectReconciliation,
} from "../../btcc/effects/index.ts";
import {
  normalizeExpectedSha256,
  normalizeWorkspaceContainedPath,
  normalizeWorkspaceFileTarget,
  workspaceFileEffectTarget,
} from "./guided-workspace-file-target.ts";
import {
  guidedWorkspaceBytesSha256,
  observeGuidedWorkspaceEditTarget,
  type GuidedWorkspaceEditGuardOptions,
} from "./guided-workspace-file-edit-observation.ts";

export const GUIDED_WORKSPACE_FILE_EDIT_CAPABILITY = "edit_file";

export type GuidedWorkspaceFileEditInput = {
  path: string;
  start_line: number;
  old_text: string;
  new_text: string;
  before_sha256: string;
  after_sha256: string;
};

export type GuidedWorkspaceFileEditResult = {
  ok: true;
  effect: "workspace_file_edit";
  path: string;
  bytes: number;
  before_sha256: string;
  after_sha256: string;
  target_observed: true;
};

export type RegisteredEditFileInput = {
  path: string;
  start_line: number;
  old_text: string;
  new_text: string;
  expected_sha256: string;
};

export type GuidedWorkspaceFileEditAdapterOptions =
  GuidedWorkspaceEditGuardOptions & {
    executeEditFile(input: RegisteredEditFileInput): Promise<unknown>;
  };

const INPUT_FIELDS = new Set([
  "path",
  "start_line",
  "old_text",
  "new_text",
  "before_sha256",
  "after_sha256",
]);

export function createGuidedWorkspaceFileEditEffectAdapter(
  options: GuidedWorkspaceFileEditAdapterOptions,
): EffectAdapter<GuidedWorkspaceFileEditInput, GuidedWorkspaceFileEditResult> {
  return {
    capability: GUIDED_WORKSPACE_FILE_EDIT_CAPABILITY,
    reviewedPlanBinding: "accepted_plan",
    normalizeTarget: normalizeWorkspaceFileTarget,
    sanitizeTarget: (target) => target,
    normalizeInput: (input) => normalizeEditEffectInput(input, options.workspacePath),
    async dispatch(input) {
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
          message: "The workspace file changed before the reviewed edit was applied.",
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
        return applied(input.normalizedInput, after.value.bytes);
      }
      const rejection = registeredToolRejection(registeredResult);
      if (rejection) return notApplied(rejection);
      return uncertain(after.ok ? stateMismatch() : after.error);
    },
    async reconcile(input) {
      const mismatch = targetInputMismatch(
        input.normalizedTarget,
        input.normalizedInput,
      );
      if (mismatch) return { status: "uncertain", error: mismatch };
      const observation = await observeGuidedWorkspaceEditTarget(
        options,
        input.normalizedInput.path,
      );
      if (!observation.ok) {
        return { status: "uncertain", error: observation.error };
      }
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
  };
}

export function guidedWorkspaceEditInputSha256(
  value: GuidedWorkspaceFileEditInput,
): string {
  return guidedWorkspaceBytesSha256(
    Buffer.from(stableEffectJson(value), "utf8"),
  );
}

function normalizeEditEffectInput(
  input: unknown,
  workspacePath: string,
): GuidedWorkspaceFileEditInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("edit_file effect input must be an object");
  }
  const record = input as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !INPUT_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new Error(`edit_file effect rejects unknown input: ${unknown.join(", ")}`);
  }
  if (!Number.isSafeInteger(record.start_line) || Number(record.start_line) < 1) {
    throw new Error("edit_file effect start_line must be a positive integer");
  }
  if (typeof record.old_text !== "string" || record.old_text.length === 0) {
    throw new Error("edit_file effect old_text must be non-empty");
  }
  if (typeof record.new_text !== "string") {
    throw new Error("edit_file effect new_text must be a string");
  }
  return {
    path: normalizeWorkspaceContainedPath(
      workspacePath,
      requiredText(record.path, "path"),
    ),
    start_line: Number(record.start_line),
    old_text: record.old_text,
    new_text: record.new_text,
    before_sha256: requiredSha(record.before_sha256, "before_sha256"),
    after_sha256: requiredSha(record.after_sha256, "after_sha256"),
  };
}

function applied(
  input: GuidedWorkspaceFileEditInput,
  bytes: number,
): EffectDispatchOutcome<GuidedWorkspaceFileEditResult> &
  EffectReconciliation<GuidedWorkspaceFileEditResult> {
  return {
    status: "applied",
    result: {
      ok: true,
      effect: "workspace_file_edit",
      path: input.path,
      bytes,
      before_sha256: input.before_sha256,
      after_sha256: input.after_sha256,
      target_observed: true,
    },
  };
}

function notApplied(
  error: EffectAdapterError,
): EffectDispatchOutcome<GuidedWorkspaceFileEditResult> {
  return { status: "not_applied", error };
}

function uncertain(
  error: EffectAdapterError,
): EffectDispatchOutcome<GuidedWorkspaceFileEditResult> {
  return { status: "uncertain", error };
}

function targetInputMismatch(
  target: string,
  input: GuidedWorkspaceFileEditInput,
): EffectAdapterError | null {
  return target === workspaceFileEffectTarget(input.path)
    ? null
    : {
        code: "workspace_target_input_mismatch",
        message: "The reviewed edit target does not match the normalized input path.",
      };
}

function registeredToolRejection(value: unknown): EffectAdapterError | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.ok !== false) return null;
  const code = typeof record.error === "string"
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
    message: "The workspace file matches neither the durable before nor after state.",
  };
}

function requiredSha(value: unknown, field: string): string {
  const normalized = normalizeExpectedSha256(value);
  if (!normalized) throw new Error(`edit_file effect requires ${field}`);
  return normalized;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`edit_file requires ${field}`);
  }
  return value.trim();
}
