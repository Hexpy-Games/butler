import type {
  OperationAuthority,
  OperationRequest,
  PhaseConversationCommand,
  PhaseConversationSnapshot,
  PhaseEnvelope,
  OperationResult,
} from "./contracts.ts";
import {
  isBtccOperationalInterruption,
  OperationalInterruptionError,
} from "../recovery/index.ts";

export async function runPhaseConversation<Product>(
  command: PhaseConversationCommand<Product>,
): Promise<Product> {
  try {
    return await runPhaseConversationAtCheckpoint(command);
  } catch (error) {
    if (isBtccOperationalInterruption(error)) throw error;
    reportPhaseContractInterruption(command, error);
    throw new OperationalInterruptionError(
      "phase_contract_interruption",
      command.binding,
      { kind: "runtime_remediation" },
      error,
    );
  }
}

function reportPhaseContractInterruption<Product>(
  command: PhaseConversationCommand<Product>,
  error: unknown,
): void {
  if (process.env.BUTLER_OPERATIONAL_DIAGNOSTICS !== "1") return;
  console.error(JSON.stringify({
    event: "btcc_phase_contract_interruption",
    phase: command.phaseContract.phase,
    checkpointId: command.binding.checkpointId,
    cause: {
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error),
    },
  }));
}

async function runPhaseConversationAtCheckpoint<Product>(
  command: PhaseConversationCommand<Product>,
): Promise<Product> {
  command.executionPermit.assertActive();
  let conversation = await command.store.restore<Product>(command.binding);
  command.executionPermit.assertActive();
  if (conversation.acceptedProduct) {
    if (!conversation.acceptedActualIdentity) {
      throw new Error("BTCC accepted phase product has no actual model identity");
    }
    assertActualModel(command.modelSelection, conversation.acceptedActualIdentity);
    return conversation.acceptedProduct;
  }

  while (true) {
    const envelope = assembleEnvelope(command, conversation);
    command.executionPermit.assertActive();
    if (conversation.pendingOperationRound) {
      assertActualModel(
        command.modelSelection,
        conversation.pendingOperationRound.actualIdentity,
      );
      const results = await performRequestedObservations(
        command,
        envelope,
        conversation.pendingOperationRound.requests,
      );
      conversation = {
        ...conversation,
        binding: await command.store.appendOperationResults({
          binding: conversation.binding,
          results,
        }),
        operationResults: [...conversation.operationResults, ...results.map((item) => item.result)],
        pendingOperationRound: undefined,
      };
      continue;
    }
    if (conversation.pendingSubmissionRound) {
      assertActualModel(command.modelSelection, conversation.pendingSubmissionRound.actualIdentity);
      const product = decodePhaseSubmission(
        command,
        conversation.pendingSubmissionRound.submission,
        envelope,
      );
      command.executionPermit.assertActive();
      await command.store.acceptPhaseProduct({
        binding: conversation.binding,
        product,
      });
      command.executionPermit.assertActive();
      return product;
    }
    const round = await command.model.runRound(envelope, command.executionPermit.signal);
    command.executionPermit.assertActive();
    if (round.kind === "interruption") {
      throw new OperationalInterruptionError(
        round.code,
        envelope.binding,
        round.activation,
      );
    }
    assertActualModel(command.modelSelection, round.actualIdentity);
    if (round.kind === "operation_requests") {
      conversation = {
        ...conversation,
        binding: await command.store.appendOperationRound({
          binding: conversation.binding,
          envelope,
          requests: round.requests,
          actualIdentity: round.actualIdentity,
        }),
        pendingOperationRound: round,
      };
      continue;
    }
    decodePhaseSubmission(command, round.submission, envelope);
    conversation = {
      ...conversation,
      binding: await command.store.appendPhaseSubmission({
        binding: conversation.binding,
        envelope,
        submission: round.submission,
        actualIdentity: round.actualIdentity,
      }),
      pendingSubmissionRound: round,
    };
  }
}

function decodePhaseSubmission<Product>(
  command: PhaseConversationCommand<Product>,
  submission: unknown,
  envelope: PhaseEnvelope,
): Product {
  try {
    return command.codec.decode(submission, envelope);
  } catch (error) {
    if (process.env.BUTLER_OPERATIONAL_DIAGNOSTICS === "1") {
      console.error(JSON.stringify({
        event: "btcc_phase_submission_rejected",
        phase: envelope.phase,
        checkpointId: envelope.binding.checkpointId,
        cause: {
          name: error instanceof Error ? error.name : "UnknownError",
          message: error instanceof Error ? error.message : String(error),
        },
      }));
    }
    throw new OperationalInterruptionError(
      "provider_phase_submission_invalid",
      envelope.binding,
      { kind: "automatic_provider_recovery" },
      error,
    );
  }
}

function assembleEnvelope<Product>(
  command: PhaseConversationCommand<Product>,
  conversation: PhaseConversationSnapshot<Product>,
): PhaseEnvelope {
  return {
    binding: conversation.binding,
    ...command.phaseContract,
    modelSelection: command.modelSelection,
    context: command.context,
    operationAuthority: command.operationAuthority,
    operationResults: conversation.operationResults,
    submissionSchema: command.codec.submissionSchema,
    ...(command.providerCorrection
      ? { providerCorrection: command.providerCorrection }
      : {}),
  };
}

async function performRequestedObservations<Product>(
  command: PhaseConversationCommand<Product>,
  envelope: PhaseEnvelope,
  requests: OperationRequest[],
): Promise<Array<{ request: OperationRequest; result: OperationResult }>> {
  if (requests.length === 0) {
    throw new Error("BTCC operation request carrier must not be empty");
  }
  const roundRequests = new Map<string, OperationRequest>();
  const results: Array<{
    request: OperationRequest;
    result: OperationResult;
  }> = [];
  for (const request of requests) {
    command.executionPermit.assertActive();
    assertAuthorizedOperation(request, command.operationAuthority);
    const existing = roundRequests.get(request.requestId);
    if (existing) {
      if (!sameRequest(existing, request)) {
        throw new Error("BTCC provider round reused one request ID for different operations");
      }
      throw new Error("BTCC provider round contains a duplicate operation request ID");
    }
    roundRequests.set(request.requestId, request);
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
    results.push({ request, result });
  }
  command.executionPermit.assertActive();
  return results;
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
  } else if (request.kind === "workspace_artifact_observation") {
    if (
      authority.mutation.kind === "workspace_only" &&
      sameRef(request.workspaceRef, authority.mutation.workspaceRef)
    ) return;
  } else if (request.kind === "workspace_artifact_action") {
    if (
      authority.mutation.kind === "workspace_only" &&
      sameRef(request.workspaceRef, authority.mutation.workspaceRef) &&
      (authority.mutation.operationRoot.kind === "directory" ||
        request.relativeTarget === authority.mutation.operationRoot.relativeTarget) &&
      isAuthorizedMutationTarget(request.relativeTarget, authority.mutation.mutationScope)
    ) return;
  } else if (request.kind === "review_validation" &&
    authority.mutation.kind === "validation_overlay_only" &&
    sameRef(request.reviewSourceRef, authority.mutation.reviewSourceRef)
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
  throw new Error("BTCC phase requested an operation outside its admitted authority");
}

function isAuthorizedMutationTarget(
  relativeTarget: string,
  scope: Extract<OperationAuthority["mutation"], { kind: "workspace_only" }>["mutationScope"],
): boolean {
  if (scope.kind === "read_only") return true;
  return scope.writablePaths.some((path) => containsRelativePath(path, relativeTarget));
}

function containsRelativePath(parent: string, child: string): boolean {
  return parent === "." || child === parent || child.startsWith(`${parent}/`);
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
