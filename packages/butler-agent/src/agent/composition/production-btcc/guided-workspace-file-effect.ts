import { join } from "node:path";
import type {
  EffectAdapter,
  EffectAdapterError,
  EffectDispatchOutcome,
  EffectReconciliation,
} from "../../btcc/effects/index.ts";
import {
  expectedWorkspaceFileSha256,
  guardWorkspaceFileTarget,
  normalizeWorkspaceContainedPath,
  normalizeWorkspaceFileTarget,
  observeWorkspaceFileTarget,
  type ObservedWorkspaceFileTarget,
  workspaceFileEffectTarget,
} from "./guided-workspace-file-target.ts";

export { workspaceFileEffectTarget } from "./guided-workspace-file-target.ts";

export const GUIDED_WORKSPACE_FILE_CAPABILITY = "write_file";

export type GuidedWorkspaceFileInput = {
  path: string;
  content: string;
  create_parents: boolean;
};

type RegisteredWriteFileInput = GuidedWorkspaceFileInput & {
  overwrite: boolean;
  expected_sha256?: string;
};

export type GuidedWorkspaceFileResult = {
  ok: true;
  effect: "workspace_file_write";
  path: string;
  bytes: number;
  after_sha256: string;
  create_parents: boolean;
  target_observed: true;
};

export type RegisteredWriteFile = (
  input: RegisteredWriteFileInput,
) => Promise<unknown>;

type WorkspaceFileAdapterOptions = {
  workspacePath: string;
  butlerData?: string;
  protectedProjectLedgerRoots?: string[];
  executeWriteFile: RegisteredWriteFile;
};

const INPUT_FIELDS = new Set([
  "path",
  "content",
  "create_parents",
]);
export function createGuidedWorkspaceFileEffectAdapter(
  options: WorkspaceFileAdapterOptions,
): EffectAdapter<GuidedWorkspaceFileInput, GuidedWorkspaceFileResult> {
  const protectedProjectLedgerRoots = [
    ...(options.butlerData
      ? [join(options.butlerData, "project-ledger", "projects")]
      : []),
    ...(options.protectedProjectLedgerRoots ?? []),
  ];

  return {
    capability: GUIDED_WORKSPACE_FILE_CAPABILITY,
    reviewedPlanBinding: "accepted_plan",
    normalizeTarget(target) {
      return normalizeWorkspaceFileTarget(target);
    },
    sanitizeTarget(normalizedTarget) {
      return normalizedTarget;
    },
    normalizeInput(input) {
      return normalizeWorkspaceFileInput(input, options.workspacePath);
    },
    async dispatch(input) {
      const mismatch = targetInputMismatch(
        input.normalizedTarget,
        input.normalizedInput,
      );
      if (mismatch) return notApplied(mismatch);
      const guarded = await guardWorkspaceFileTarget({
        workspacePath: options.workspacePath,
        protectedProjectLedgerRoots,
        path: input.normalizedInput.path,
      });
      if (!guarded.ok) return notApplied(guarded.error);
      if (input.signal.aborted) {
        return notApplied({
          code: "write_file_cancelled",
          message: "write_file was cancelled before registered tool dispatch.",
        });
      }

      const before = await observeWorkspaceFileTarget(guarded.target);
      const prepared = prepareRegisteredWrite(input.normalizedInput, before);
      if (!prepared.ok) return prepared.outcome;
      const registeredResult = await options.executeWriteFile(prepared.input);
      const observation = await observeWorkspaceFileTarget(guarded.target);
      if (
        observation.status === "file" &&
        observation.sha256 ===
          expectedWorkspaceFileSha256(input.normalizedInput.content)
      ) {
        return applied(input.normalizedInput, observation);
      }
      const rejection = registeredToolRejection(registeredResult);
      if (rejection) return notApplied(rejection);
      return uncertain(observationError(observation));
    },
    async reconcile(input) {
      const mismatch = targetInputMismatch(
        input.normalizedTarget,
        input.normalizedInput,
      );
      if (mismatch) return { status: "uncertain", error: mismatch };
      const guarded = await guardWorkspaceFileTarget({
        workspacePath: options.workspacePath,
        protectedProjectLedgerRoots,
        path: input.normalizedInput.path,
      });
      if (!guarded.ok) return { status: "uncertain", error: guarded.error };
      const observation = await observeWorkspaceFileTarget(guarded.target);
      return reconcileObservation(
        input.normalizedInput,
        observation,
        input.dispatchAttempts,
      );
    },
  };
}

function normalizeWorkspaceFileInput(
  input: unknown,
  workspacePath: string,
): GuidedWorkspaceFileInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("write_file effect input must be an object");
  }
  const record = input as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !INPUT_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new Error(`write_file effect rejects unknown input: ${unknown.join(", ")}`);
  }
  if (typeof record.content !== "string") {
    throw new Error("write_file effect content must be a string");
  }
  if (
    record.create_parents !== undefined &&
    typeof record.create_parents !== "boolean"
  ) {
    throw new Error("write_file effect create_parents must be a boolean");
  }
  return {
    path: normalizeWorkspaceContainedPath(
      workspacePath,
      requiredString(record.path, "path"),
    ),
    content: record.content,
    create_parents: record.create_parents ?? false,
  };
}

function reconcileObservation(
  input: GuidedWorkspaceFileInput,
  observation: ObservedWorkspaceFileTarget,
  dispatchAttempts = 1,
): EffectReconciliation<GuidedWorkspaceFileResult> {
  if (
    observation.status === "file" &&
    observation.sha256 === expectedWorkspaceFileSha256(input.content)
  ) {
    return applied(input, observation);
  }
  if (dispatchAttempts === 0) {
    return { status: "not_applied" };
  }
  return { status: "uncertain", error: observationError(observation) };
}

function prepareRegisteredWrite(
  input: GuidedWorkspaceFileInput,
  observation: ObservedWorkspaceFileTarget,
):
  | { ok: true; input: RegisteredWriteFileInput }
  | { ok: false; outcome: EffectDispatchOutcome<GuidedWorkspaceFileResult> } {
  if (observation.status === "unavailable") {
    return { ok: false, outcome: uncertain(observation.error) };
  }
  return {
    ok: true,
    input: {
      ...input,
      overwrite: observation.status === "file",
      ...(observation.status === "file"
        ? { expected_sha256: observation.sha256 }
        : {}),
    },
  };
}

function targetInputMismatch(
  normalizedTarget: string,
  input: GuidedWorkspaceFileInput,
): EffectAdapterError | null {
  if (normalizedTarget === workspaceFileEffectTarget(input.path)) return null;
  return {
    code: "write_file_target_input_mismatch",
    message: "write_file target does not match its normalized path.",
  };
}

function applied(
  input: GuidedWorkspaceFileInput,
  observation: Extract<ObservedWorkspaceFileTarget, { status: "file" }>,
): Extract<
  EffectDispatchOutcome<GuidedWorkspaceFileResult>,
  { status: "applied" }
> {
  return {
    status: "applied",
    result: {
      ok: true,
      effect: "workspace_file_write",
      path: input.path,
      bytes: observation.bytes,
      after_sha256: observation.sha256,
      create_parents: input.create_parents,
      target_observed: true,
    },
  };
}

function notApplied(
  error: EffectAdapterError,
): EffectDispatchOutcome<GuidedWorkspaceFileResult> {
  return { status: "not_applied", error };
}

function uncertain(
  error: EffectAdapterError,
): EffectDispatchOutcome<GuidedWorkspaceFileResult> {
  return { status: "uncertain", error };
}

function registeredToolRejection(result: unknown): EffectAdapterError | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  if (record.ok !== false) return null;
  const code = typeof record.error === "string"
    ? record.error
    : "registered_write_file_rejected";
  return {
    code,
    message: "The registered write_file tool rejected the target or input.",
  };
}

function observationError(
  observation: ObservedWorkspaceFileTarget,
): EffectAdapterError {
  if (observation.status === "unavailable") return observation.error;
  return {
    code: "workspace_file_state_mismatch",
    message: "Current target bytes do not prove whether write_file was applied.",
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`write_file effect ${field} must be a non-empty string`);
  }
  return value.trim();
}
