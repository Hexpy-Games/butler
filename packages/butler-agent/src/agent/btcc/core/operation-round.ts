import {
  projectEphemeralOperationResult,
  type OperationResultProjection,
} from "../operation-result/index.ts";
import {
  OperationRejectedError,
  rejectedOperationResult,
} from "./operation-rejection.ts";
import type {
  OperationAuthority,
  OperationRequest,
  OperationResult,
  PhaseConversationCommand,
  PhaseEnvelope,
} from "./contracts.ts";
import { phaseActivityId } from "./phase-activity.ts";

export function normalizeOperationResult(
  result: OperationResult,
  binding: PhaseEnvelope["binding"],
  modelSelection: PhaseEnvelope["modelSelection"],
): OperationResultProjection {
  if (isOperationResultProjection(result)) return result;
  if (!result.content) {
    throw new Error("BTCC operation result has neither a projection nor complete content");
  }
  return projectEphemeralOperationResult({
    binding,
    request: result.request,
    result: { ...result, content: result.content },
    modelSelection,
  });
}

export async function performOperationBatch<Product>(
  command: PhaseConversationCommand<Product>,
  envelope: PhaseEnvelope,
  requests: OperationRequest[],
): Promise<Array<{ request: OperationRequest; result: OperationResultProjection }>> {
  if (requests.length === 0) {
    throw new Error("BTCC operation request carrier must not be empty");
  }
  const roundRequests = new Map<string, OperationRequest>();
  const results: Array<{ request: OperationRequest; result: OperationResultProjection }> = [];
  for (const request of requests) {
    command.executionPermit.assertActive();
    rejectDuplicateRequest(roundRequests, request);
    requirePublicOperationMetadata(request);
    await publishOperation(command, envelope, request, "started");
    try {
      assertAuthorizedOperationKind(request, envelope.operationAuthority);
      const observed = await command.operations.perform({
        request,
        envelope,
        signal: command.executionPermit.signal,
      });
      command.executionPermit.assertActive();
      if (observed.requestId !== request.requestId) {
        throw new Error("BTCC observation result does not match its request");
      }
      const result = isOperationResultProjection(observed)
        ? { ...observed, request }
        : projectEphemeralOperationResult({
            binding: envelope.binding,
            request,
            result: observed,
            modelSelection: envelope.modelSelection,
          });
      await publishOperation(command, envelope, request, "completed", result);
      results.push({ request, result });
    } catch (error) {
      if (error instanceof OperationRejectedError) {
        const result = projectEphemeralOperationResult({
          binding: envelope.binding,
          request,
          result: rejectedOperationResult(request, error),
          modelSelection: envelope.modelSelection,
        });
        await publishOperation(command, envelope, request, "completed", result);
        results.push({ request, result });
        continue;
      }
      await publishOperation(
        command,
        envelope,
        request,
        isAbortError(error, command.executionPermit.signal) ? "cancelled" : "failed",
      );
      throw error;
    }
  }
  command.executionPermit.assertActive();
  return results;
}

async function publishOperation<Product>(
  command: PhaseConversationCommand<Product>,
  envelope: PhaseEnvelope,
  request: OperationRequest,
  status: "started" | "completed" | "failed" | "cancelled",
  result?: OperationResultProjection,
): Promise<void> {
  await command.activity?.operationChanged?.({
    turnId: envelope.binding.turnId,
    semanticState: envelope.binding.semanticState,
    request,
    activityId: phaseActivityId(envelope.binding),
    status,
    ...(result ? { resultRef: result.resultRef, byteLength: result.byteLength } : {}),
  });
}

function requirePublicOperationMetadata(request: OperationRequest): void {
  if (!request.publicTitle.trim() || request.publicTitle.length > 120) {
    throw new Error("BTCC operation request requires a public title");
  }
  if (
    request.requestId.length > 96 ||
    !/^[A-Za-z0-9_.:/-]+$/u.test(request.requestId)
  ) {
    throw new Error("BTCC operation request requires a stable request ID");
  }
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

function rejectDuplicateRequest(
  roundRequests: Map<string, OperationRequest>,
  request: OperationRequest,
): void {
  const existing = roundRequests.get(request.requestId);
  if (existing && JSON.stringify(existing) !== JSON.stringify(request)) {
    throw new Error("BTCC provider round reused one request ID for different operations");
  }
  if (existing) {
    throw new Error("BTCC provider round contains a duplicate operation request ID");
  }
  roundRequests.set(request.requestId, request);
}

function isOperationResultProjection(
  result: OperationResult | Awaited<
    ReturnType<PhaseConversationCommand<unknown>["operations"]["perform"]>
  >,
): result is OperationResultProjection {
  return "resultRef" in result && "preview" in result && "readScopeRef" in result;
}

function assertAuthorizedOperationKind(
  request: OperationRequest,
  authority: OperationAuthority,
): void {
  if (request.runtimeAdmission?.kind === "rejected") {
    throw new OperationRejectedError(
      request.runtimeAdmission.code,
      "This operation is not authorized in the current BTCC phase.",
    );
  }
  if (request.kind === "observe") {
    if (authority.observationScopeRefs.includes(request.scopeRef)) return;
  } else if (
    request.kind === "workspace_artifact_observation" &&
    authority.mutation.kind === "workspace_only" &&
    sameRef(request.workspaceRef, authority.mutation.workspaceRef)
  ) {
    return;
  } else if (
    request.kind === "workspace_artifact_action" &&
    authority.mutation.kind === "workspace_only" &&
    authority.mutation.mutationScope.kind === "contained_paths" &&
    sameRef(request.workspaceRef, authority.mutation.workspaceRef)
  ) {
    return;
  } else if (
    request.kind === "review_validation" &&
    authority.mutation.kind === "validation_overlay_only" &&
    sameRef(request.reviewSourceRef, authority.mutation.reviewSourceRef)
  ) {
    return;
  } else if (
    request.kind === "turn_local_effect" &&
    authority.mutation.kind === "turn_local_effect_only" &&
    authority.mutation.capabilityRefs.includes(request.capabilityRef)
  ) {
    return;
  } else if (
    request.kind === "external_effect" &&
    authority.mutation.kind === "external_effect_only" &&
    sameRef(request.effectIntentRef, authority.mutation.effectIntentRef) &&
    request.occurrenceKey === authority.mutation.occurrenceKey &&
    request.targetScopeRef === authority.mutation.targetScopeRef
  ) {
    return;
  } else if (
    request.kind === "repository_promotion" &&
    authority.mutation.kind === "repository_promotion_only" &&
    sameRef(request.authorizationRef, authority.mutation.authorizationRef) &&
    sameRef(request.candidateRef, authority.mutation.candidateRef) &&
    sameRef(request.resolutionRef, authority.mutation.resolutionRef) &&
    sameRef(request.baselineRef, authority.mutation.baselineRef) &&
    sameRef(request.finalSnapshotRef, authority.mutation.finalSnapshotRef)
  ) {
    return;
  }
  throw new OperationRejectedError(
    "operation_authority_mismatch",
    "This operation is not authorized in the current BTCC phase.",
  );
}

function sameRef(
  left: { id: string; sha256: string },
  right: { id: string; sha256: string },
): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}
