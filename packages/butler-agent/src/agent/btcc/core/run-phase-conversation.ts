import type {
  OperationAuthority,
  OperationRequest,
  PhaseConversationCommand,
  PhaseEnvelope,
} from "./contracts.ts";
import { OperationalInterruptionError } from "../recovery/index.ts";

export async function runPhaseConversation<Product>(
  command: PhaseConversationCommand<Product>,
): Promise<Product> {
  command.executionPermit.assertActive();
  const accepted = await command.store.loadAcceptedProduct<Product>(command.binding);
  command.executionPermit.assertActive();
  if (accepted) return accepted;

  while (true) {
    const envelope = await assembleEnvelope(command);
    command.executionPermit.assertActive();
    const round = await command.model.runRound(envelope, command.executionPermit.signal);
    command.executionPermit.assertActive();
    if (round.kind === "interruption") {
      throw new OperationalInterruptionError(round.code, command.binding);
    }
    assertActualModel(command.modelSelection, round.actualIdentity);
    if (round.kind === "operation_requests") {
      await performRequestedObservations(command, envelope, round.requests);
      continue;
    }
    const product = command.codec.decode(round.submission, envelope);
    command.executionPermit.assertActive();
    await command.store.persistAcceptedProduct({
      binding: command.binding,
      product,
      actualIdentity: round.actualIdentity,
    });
    command.executionPermit.assertActive();
    return product;
  }
}

async function assembleEnvelope<Product>(
  command: PhaseConversationCommand<Product>,
): Promise<PhaseEnvelope> {
  return {
    binding: command.binding,
    ...command.phaseContract,
    modelSelection: command.modelSelection,
    context: command.context,
    operationAuthority: command.operationAuthority,
    operationResults: await command.store.loadOperationResults(command.binding),
  };
}

async function performRequestedObservations<Product>(
  command: PhaseConversationCommand<Product>,
  envelope: PhaseEnvelope,
  requests: OperationRequest[],
): Promise<void> {
  if (requests.length === 0) {
    throw new Error("BTCC operation request carrier must not be empty");
  }
  const existingRequests = new Map(
    envelope.operationResults.map((result) => [result.requestId, result.request]),
  );
  for (const request of requests) {
    command.executionPermit.assertActive();
    assertAuthorizedOperation(request, command.operationAuthority);
    const existing = existingRequests.get(request.requestId);
    if (existing) {
      if (!sameRequest(existing, request)) {
        throw new Error("BTCC operation request identity conflict");
      }
      continue;
    }
    const observation = await command.operations.perform({
      request,
      envelope,
      signal: command.executionPermit.signal,
    });
    command.executionPermit.assertActive();
    if (observation.requestId !== request.requestId) {
      throw new Error("BTCC observation result does not match its request");
    }
    const result = { ...observation, request };
    await command.store.appendOperationResult({
      binding: command.binding,
      request,
      result,
    });
    command.executionPermit.assertActive();
    existingRequests.set(request.requestId, request);
  }
}

function sameRequest(
  left: OperationRequest,
  right: OperationRequest,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertAuthorizedOperation(
  request: OperationRequest,
  authority: OperationAuthority,
): void {
  if (request.kind === "observe") {
    if (authority.observationScopeRefs.includes(request.scopeRef)) return;
  } else if (request.kind === "workspace_artifact_action") {
    if (
      authority.mutation.kind === "workspace_only" &&
      sameRef(request.workspaceRef, authority.mutation.workspaceRef)
    ) return;
  } else if (request.kind === "review_validation" &&
    authority.mutation.kind === "validation_overlay_only" &&
    sameRef(request.reviewSourceRef, authority.mutation.reviewSourceRef)
  ) {
    return;
  } else if (
    request.kind === "repository_promotion" &&
    authority.mutation.kind === "repository_promotion_only" &&
    sameRef(request.authorizationRef, authority.mutation.authorizationRef)
  ) {
    return;
  }
  throw new Error("BTCC phase requested an operation outside its admitted authority");
}

function sameRef(
  left: { id: string; sha256: string },
  right: { id: string; sha256: string },
): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}

function assertActualModel(
  expected: PhaseConversationCommand<unknown>["modelSelection"],
  actual: {
    provider: string;
    model: string;
    reasoningEffort: string;
    controlsHash: string;
  },
): void {
  if (
    actual.provider !== expected.provider ||
    actual.model !== expected.model ||
    actual.reasoningEffort !== expected.reasoningEffort ||
    actual.controlsHash !== expected.controlsHash
  ) {
    throw new Error("BTCC selected model identity mismatch");
  }
}
