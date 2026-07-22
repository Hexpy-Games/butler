import { resolve } from "node:path";
import type {
  OperationRequest,
  PhaseEnvelope,
  ProductionOperationRuntimeOptions,
} from "../../btcc/index.ts";
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
  | "createIsolatedValidationExecutor"
  | "validateOperationInput"
> {
  return {
    createToolExecutor: ({ envelope, request }) =>
      toolExecutor(
        options,
        envelope,
        workspaceForObservation(envelope, request, options.butlerHome),
        request,
      ),
    createWorkspaceToolExecutor: ({ workspacePath, envelope, request }) =>
      toolExecutor(options, envelope, workspacePath, request, isolatedBoundary(envelope)),
    createIsolatedValidationExecutor: ({ workspacePath, envelope, request }) =>
      toolExecutor(options, envelope, workspacePath, request, isolatedBoundary(envelope)),
    validateOperationInput: ({ request, args }) => validateInput(request, args),
  };
}

function toolExecutor(
  options: ToolRuntimeOptions,
  envelope: PhaseEnvelope,
  workspacePath: string,
  request: OperationRequest,
  commandFilesystemBoundary?: {
    kind: "isolated_workspace";
    deniedReadWriteRoots: string[];
  },
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
      ...(envelope.context.projectRef ? { projectRef: envelope.context.projectRef } : {}),
      ...(options.resolveProjectLedgerRoot
        ? { resolveProjectLedgerRoot: options.resolveProjectLedgerRoot }
        : {}),
      originalRequest: envelope.context.originalMessage,
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
  request: OperationRequest,
  args: Record<string, unknown>,
): void {
  if (request.kind === "repository_promotion") {
    if (Object.keys(args).length === 0) return;
    throw new Error("BTCC promotion capability accepts no model-authored arguments");
  }
  const capability = requireCapability(request);
  const result = validateJsonObjectSchema(args, capability.inputSchema);
  if (!result.ok) {
    throw new Error(`BTCC capability input is invalid at ${result.path}: ${result.message}`);
  }
  if (
    request.kind === "workspace_artifact_action" &&
    request.capabilityRef === "write_file" &&
    args.path !== request.relativeTarget
  ) {
    throw new Error("BTCC write_file path must equal the planned relative target");
  }
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
