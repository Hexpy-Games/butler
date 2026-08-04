import { relative, sep } from "node:path";
import type {
  EffectAdapter,
  EffectDispatchOutcome,
} from "../effects/index.ts";
import {
  executeGuidedCommand,
  resolveGuidedCommandDirectory,
} from "./guided-command/execute-command.ts";
import { canonicalCommandRoot } from "./guided-command/command-host.ts";
import {
  guidedCommandPublicResult,
  type GuidedSpooledCommandResult,
} from "./guided-read-only-command.ts";

export const GUIDED_COMMAND_EFFECT_CAPABILITY = "run_command";
export const GUIDED_REMOTE_OBSERVATION_EFFECT_CAPABILITY =
  "run_command_remote_observation";

type GuidedCommandPersistentStateEffect = "mutation" | "remote_observation";

export type GuidedCommandEffectInput = {
  command: string;
  cwd: string;
  state_effect: GuidedCommandPersistentStateEffect;
  timeout_ms?: number;
  max_output_tokens?: number;
  output_paths?: string[];
  output_mode?: "auto" | "silent_on_success" | "full";
};

export type GuidedCommandEffectResult = Record<string, unknown> & {
  effect: "command_mutation" | "remote_observation";
  command_outcome_observed: true;
};

export async function prepareGuidedCommandEffect(input: {
  args: Record<string, unknown>;
  butlerData: string;
  workspacePath: string;
  originalRequest: string;
}): Promise<{
  target: string;
  input: GuidedCommandEffectInput;
  adapter: EffectAdapter<GuidedCommandEffectInput, GuidedCommandEffectResult>;
}> {
  const resolvedCwd = await resolveGuidedCommandDirectory(
    input.workspacePath,
    input.args.cwd,
  );
  const workspaceRoot = canonicalCommandRoot(input.workspacePath);
  const canonicalCwd = canonicalCommandRoot(resolvedCwd);
  const cwd = relative(workspaceRoot, canonicalCwd).split(sep).join("/") || ".";
  const normalizedInput = normalizeCommandEffectInput({ ...input.args, cwd });
  const target = commandEffectTarget(cwd, normalizedInput.state_effect);
  return {
    target,
    input: normalizedInput,
    adapter: createGuidedCommandEffectAdapter({
      butlerData: input.butlerData,
      workspacePath: input.workspacePath,
      canonicalWorkspacePath: workspaceRoot,
      resolvedCwd,
      canonicalCwd,
      originalRequest: input.originalRequest,
      target,
      stateEffect: normalizedInput.state_effect,
    }),
  };
}

function createGuidedCommandEffectAdapter(input: {
  butlerData: string;
  workspacePath: string;
  canonicalWorkspacePath: string;
  resolvedCwd: string;
  canonicalCwd: string;
  originalRequest: string;
  target: string;
  stateEffect: GuidedCommandPersistentStateEffect;
}): EffectAdapter<GuidedCommandEffectInput, GuidedCommandEffectResult> {
  return {
    capability: input.stateEffect === "remote_observation"
      ? GUIDED_REMOTE_OBSERVATION_EFFECT_CAPABILITY
      : GUIDED_COMMAND_EFFECT_CAPABILITY,
    reviewedPlanBinding: "accepted_plan",
    normalizeTarget(target) {
      const normalized = requiredString(target, "target");
      if (normalized !== input.target) {
        throw new Error("run_command effect target changed after workspace admission");
      }
      return normalized;
    },
    sanitizeTarget(target) {
      return target;
    },
    normalizeInput: normalizeCommandEffectInput,
    async dispatch(effect) {
      if (effect.normalizedTarget !== input.target) {
        return notApplied(
          "command_target_mismatch",
          "The admitted command directory no longer matches the effect target.",
        );
      }
      if (effect.signal.aborted) {
        return notApplied(
          "command_cancelled_before_dispatch",
          "The command was cancelled before dispatch.",
        );
      }
      if (
        canonicalCommandRoot(input.workspacePath) !==
          input.canonicalWorkspacePath ||
        canonicalCommandRoot(input.resolvedCwd) !== input.canonicalCwd
      ) {
        return notApplied(
          "command_workspace_identity_changed",
          "The approved command workspace or directory changed before dispatch.",
        );
      }
      const spooled = await executeGuidedCommand({
        ...effect.normalizedInput,
        cwd: input.canonicalCwd,
      }, {
        butlerData: input.butlerData,
        workspacePath: input.canonicalWorkspacePath,
        originalRequest: input.originalRequest,
        accessMode: "full_access",
        filesystemBoundary: { kind: "full_access_contained" },
        signal: effect.signal,
      }) as GuidedSpooledCommandResult;
      const outcome = guidedCommandPublicResult({
        spooled,
        butlerData: input.butlerData,
        args: effect.normalizedInput,
        sandbox: "full_access_contained",
      });
      return {
        status: "applied",
        result: {
          ...outcome,
          effect: input.stateEffect === "remote_observation"
            ? "remote_observation"
            : "command_mutation",
          command_outcome_observed: true,
        },
      };
    },
    async reconcile(effect) {
      if (effect.dispatchAttempts === 0) return { status: "not_applied" };
      return {
        status: "uncertain",
        error: {
          code: input.stateEffect === "remote_observation"
            ? "remote_observation_reconciliation_required"
            : "command_effect_reconciliation_required",
          message: "The command may have run. Inspect the workspace or external target and report the uncertainty; do not repeat it blindly.",
        },
      };
    },
  };
}

function normalizeCommandEffectInput(value: unknown): GuidedCommandEffectInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("run_command effect input must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.state_effect !== "mutation" &&
      record.state_effect !== "remote_observation") {
    throw new Error(
      "run_command persistent effect requires state_effect mutation or remote_observation",
    );
  }
  if (optionalTrimmedString(record.validation_suite, "validation_suite")) {
    throw new Error("A persistent command cannot also be a validation suite");
  }
  const normalized: GuidedCommandEffectInput = {
    command: requiredString(record.command, "command"),
    cwd: requiredString(record.cwd, "cwd"),
    state_effect: record.state_effect,
  };
  if (record.timeout_ms !== undefined) {
    normalized.timeout_ms = positiveInteger(record.timeout_ms, "timeout_ms");
  }
  if (record.max_output_tokens !== undefined) {
    normalized.max_output_tokens = positiveInteger(
      record.max_output_tokens,
      "max_output_tokens",
    );
  }
  if (record.output_paths !== undefined) {
    if (!Array.isArray(record.output_paths)) {
      throw new Error("run_command output_paths must be an array");
    }
    normalized.output_paths = record.output_paths.map((path) =>
      requiredString(path, "output path"),
    );
  }
  if (record.output_mode !== undefined) {
    if (!["auto", "silent_on_success", "full"].includes(String(record.output_mode))) {
      throw new Error("run_command output_mode is invalid");
    }
    normalized.output_mode = record.output_mode as GuidedCommandEffectInput["output_mode"];
  }
  return normalized;
}

function commandEffectTarget(
  cwd: string,
  stateEffect: GuidedCommandPersistentStateEffect,
): string {
  return stateEffect === "remote_observation"
    ? `remote-observation-command:${cwd}`
    : `workspace-command:${cwd}`;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`run_command ${label} must be a non-empty string`);
  }
  return value;
}

function optionalTrimmedString(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`run_command ${label} must be a string`);
  }
  return value.trim() || undefined;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`run_command ${label} must be a positive number`);
  }
  return Math.trunc(value);
}

function notApplied(
  code: string,
  message: string,
): EffectDispatchOutcome<GuidedCommandEffectResult> {
  return { status: "not_applied", error: { code, message } };
}
