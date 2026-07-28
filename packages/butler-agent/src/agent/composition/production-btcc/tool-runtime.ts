import { resolve } from "node:path";
import {
  OperationRejectedError,
  type OperationRequest,
  type PhaseEnvelope,
} from "../../btcc/core/index.ts";
import type {
  ProductionOperationRuntimeOptions,
} from "../../btcc/infrastructure/operations/index.ts";
import { validateJsonObjectSchema } from "../../tools/tool-bridge/schema-validation.ts";
import { PRODUCTION_CAPABILITIES } from "./capabilities/index.ts";

type ToolRuntimeOptions = {
  butlerHome: string;
  butlerData: string;
  appMessageDbPath: string;
  resolveProjectLedgerRoot?: (projectRef: string) => string;
};

export function createProductionToolRuntime(
  options: ToolRuntimeOptions,
): Pick<
  ProductionOperationRuntimeOptions,
  | "createToolExecutor"
  | "createWorkspaceToolExecutor"
  | "createWorkspaceObservationExecutor"
  | "createIsolatedValidationExecutor"
  | "createExternalEffectExecutor"
  | "validateOperationInput"
> {
  return {
    createToolExecutor: ({ envelope, request }) =>
      toolExecutor(
        options,
        envelope,
        workspaceForObservation(envelope, request, options.butlerHome),
        request,
        request.capabilityRef === "run_command"
          ? { kind: "read_only_observation" }
          : undefined,
      ),
    createWorkspaceToolExecutor: ({ workspacePath, envelope, request }) =>
      toolExecutor(options, envelope, workspacePath, request, isolatedBoundary(envelope)),
    createWorkspaceObservationExecutor: ({ workspacePath, envelope, request }) =>
      toolExecutor(options, envelope, workspacePath, request, isolatedBoundary(envelope)),
    createIsolatedValidationExecutor: ({ workspacePath, envelope, request }) =>
      toolExecutor(options, envelope, workspacePath, request, isolatedBoundary(envelope)),
    createExternalEffectExecutor: ({ envelope, request }) =>
      toolExecutor(options, envelope, options.butlerHome, request),
    validateOperationInput: ({ envelope, request, args }) =>
      validateInput(envelope, request, args),
  };
}

function toolExecutor(
  options: ToolRuntimeOptions,
  envelope: PhaseEnvelope,
  workspacePath: string,
  request: OperationRequest,
  commandFilesystemBoundary?:
    | { kind: "isolated_workspace"; deniedReadWriteRoots: string[] }
    | { kind: "read_only_observation" },
) {
  return async (call: {
    name: string;
    args: Record<string, unknown>;
    signal?: AbortSignal;
  }) => {
    const capability = requireCapability(request);
    if (call.name !== capability.name) {
      throw new Error(`BTCC requested ${request.capabilityRef} but provider invoked ${call.name}`);
    }
    return capability.execute(call.args, {
      butlerData: options.butlerData,
      workspacePath,
      ...(request.kind === "observe" ? { observationScopeRef: request.scopeRef } : {}),
      ...(request.kind === "external_effect" ? {
        externalEffect: {
          effectIntentRef: request.effectIntentRef,
          occurrenceKey: request.occurrenceKey,
          targetScopeRef: request.targetScopeRef,
          requestId: request.requestId,
        },
      } : {}),
      ...(envelope.context.projectRef ? { projectRef: envelope.context.projectRef } : {}),
      ...(options.resolveProjectLedgerRoot
        ? { resolveProjectLedgerRoot: options.resolveProjectLedgerRoot }
        : {}),
      originalRequest: envelope.context.originalMessage,
      operationKind: request.kind,
      accessMode: request.capabilityRef === "run_command"
        ? admittedAccessMode(envelope)
        : "read_only",
      ...(commandFilesystemBoundary ? { commandFilesystemBoundary } : {}),
      signal: call.signal,
    });
  };
}

function isolatedBoundary(envelope: PhaseEnvelope) {
  const deniedReadWriteRoots = envelope.context.baselineObservationScopeRefs
    .filter((scope) => scope.startsWith("workspace:"))
    .map((scope) => resolve(scope.slice("workspace:".length)));
  return {
    kind: "isolated_workspace" as const,
    deniedReadWriteRoots: [...new Set(deniedReadWriteRoots)],
  };
}

function admittedAccessMode(
  envelope: PhaseEnvelope,
): "full_access" | "ask_first" | "read_only" {
  const value = envelope.modelSelection.controls.accessMode;
  if (value === "full_access" || value === "ask_first" || value === "read_only") {
    return value;
  }
  throw new Error("BTCC command access mode is not admitted");
}

function workspaceForObservation(
  envelope: PhaseEnvelope,
  request: Extract<OperationRequest, { kind: "observe" }>,
  defaultWorkspace: string,
): string {
  if (request.scopeRef.startsWith("workspace:")) {
    return request.scopeRef.slice("workspace:".length);
  }
  const workspaceScope = envelope.context.baselineObservationScopeRefs.find(
    (scope) => scope.startsWith("workspace:"),
  );
  return workspaceScope?.slice("workspace:".length) || defaultWorkspace;
}

function validateInput(
  envelope: PhaseEnvelope,
  request: OperationRequest,
  args: Record<string, unknown>,
): void {
  if (request.kind === "repository_promotion") {
    if (Object.keys(args).length === 0) return;
    rejectInput(
      "repository_promotion_input_denied",
      "BTCC promotion capability accepts no model-authored arguments",
    );
  }
  const capability = requireCapability(request);
  const result = validateJsonObjectSchema(args, capability.inputSchema);
  if (!result.ok) {
    rejectInput(
      "capability_input_invalid",
      `BTCC capability input is invalid at ${result.path}: ${result.message}`,
    );
  }
  if (request.kind === "external_effect" && admittedAccessMode(envelope) === "read_only") {
    rejectInput(
      "read_only_access_external_effect_denied",
      "BTCC read-only access mode cannot admit an external effect",
    );
  }
  if (request.capabilityRef === "run_command") {
    validateCommandStateEffect(
      envelope,
      request,
      args,
      admittedAccessMode(envelope),
    );
  }
  if (
    request.kind === "workspace_artifact_action" &&
    request.capabilityRef === "write_file" &&
    args.path !== request.relativeTarget
  ) {
    rejectInput(
      "workspace_target_input_mismatch",
      "BTCC write_file path must equal the planned relative target",
    );
  }
}

function validateCommandStateEffect(
  envelope: PhaseEnvelope,
  request: OperationRequest,
  args: Record<string, unknown>,
  accessMode: "full_access" | "ask_first" | "read_only",
): void {
  const effect = args.state_effect;
  if (request.kind === "observe" && !request.scopeRef.startsWith("workspace:")) {
    rejectInput(
      "command_observation_scope_denied",
      "BTCC command observation requires an admitted workspace scope",
    );
  }
  if (request.kind === "observe" && effect !== "read_only") {
    rejectInput(
      "command_observation_effect_denied",
      "BTCC command observation requires state_effect read_only",
    );
  }
  if (request.kind === "review_validation" && effect !== "validation") {
    rejectInput(
      "review_validation_effect_denied",
      "BTCC Review command requires state_effect validation",
    );
  }
  if (request.kind === "workspace_artifact_action" &&
    effect !== "read_only" && effect !== "validation" && effect !== "mutation") {
    rejectInput(
      "workspace_command_effect_denied",
      "BTCC workspace command requires read_only, validation, or mutation state_effect",
    );
  }
  if (request.kind === "workspace_artifact_action" && effect === "mutation" &&
    envelope.operationAuthority.mutation.kind === "workspace_only" &&
    envelope.operationAuthority.mutation.mutationScope.kind === "read_only") {
    rejectInput(
      "read_only_task_mutation_denied",
      "BTCC read-only Task cannot admit a mutation command",
    );
  }
  if (request.kind === "workspace_artifact_action" && effect === "mutation" &&
    accessMode === "read_only") {
    rejectInput(
      "read_only_access_mutation_denied",
      "BTCC read-only access mode cannot admit a mutation command",
    );
  }
}

function rejectInput(code: string, message: string): never {
  throw new OperationRejectedError(code, message);
}

function requireCapability(request: OperationRequest) {
  if (request.kind === "repository_promotion") {
    throw new Error("BTCC promotion is executed by the artifact runtime");
  }
  const capability = PRODUCTION_CAPABILITIES.find(
    (candidate) => candidate.capabilityRef === request.capabilityRef &&
      candidate.operationKinds.includes(request.kind),
  );
  if (!capability) {
    throw new Error(`BTCC capability is unavailable for ${request.kind}: ${request.capabilityRef}`);
  }
  return capability;
}
