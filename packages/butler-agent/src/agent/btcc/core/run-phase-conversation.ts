import type {
  PhaseConversationCommand,
  PhaseConversationSnapshot,
  PhaseEnvelope,
  ProviderCorrection,
} from "./contracts.ts";
import {
  isBtccOperationalInterruption,
  OperationalInterruptionError,
  runtimeInterruption,
} from "../recovery/index.ts";
import {
  normalizeOperationResult,
  performOperationBatch,
} from "./operation-round.ts";
import { phaseOperationAuthority } from "./phase-operation-authority.ts";
import { phaseActivityId } from "./phase-activity.ts";

export async function runPhaseConversation<Product>(
  command: PhaseConversationCommand<Product>,
): Promise<Product> {
  let recoveryBinding = command.binding;
  try {
    return await runPhaseConversationAtCheckpoint(
      command,
      (binding) => (recoveryBinding = binding),
    );
  } catch (error) {
    if (isBtccOperationalInterruption(error)) throw error;
    reportPhaseContractInterruption(command, error);
    throw runtimeInterruption(error, recoveryBinding);
  }
}

function reportPhaseContractInterruption<Product>(
  command: PhaseConversationCommand<Product>,
  error: unknown,
): void {
  if (process.env.BUTLER_OPERATIONAL_DIAGNOSTICS !== "1") return;
  console.error(
    JSON.stringify({
      event: "btcc_phase_contract_interruption",
      phase: command.phaseContract.phase,
      checkpointId: command.binding.checkpointId,
      cause: {
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
      },
    }),
  );
}

async function runPhaseConversationAtCheckpoint<Product>(
  command: PhaseConversationCommand<Product>,
  checkpointAdvanced: (binding: PhaseEnvelope["binding"]) => void,
): Promise<Product> {
  command.executionPermit.assertActive();
  let conversation = await command.store.restore<Product>(command.binding);
  let providerCorrection = conversation.providerCorrection ?? command.providerCorrection;
  checkpointAdvanced(conversation.binding);
  command.executionPermit.assertActive();
  if (conversation.acceptedProduct) {
    if (!conversation.acceptedActualIdentity) {
      throw new Error(
        "BTCC accepted phase product has no actual model identity",
      );
    }
    assertActualModel(
      command.modelSelection,
      conversation.acceptedActualIdentity,
    );
    return conversation.acceptedProduct;
  }

  while (true) {
    const envelope = assembleEnvelope(command, conversation, providerCorrection);
    command.executionPermit.assertActive();
    if (conversation.pendingOperationRound) {
      assertActualModel(
        command.modelSelection,
        conversation.pendingOperationRound.actualIdentity,
      );
      const results = await performOperationBatch(
        command,
        envelope,
        conversation.pendingOperationRound.requests,
      );
      conversation = {
        ...conversation,
        binding: trackCheckpoint(
          await command.store.appendOperationResults({
            binding: conversation.binding,
            results,
          }),
          checkpointAdvanced,
        ),
        operationResults: [
          ...conversation.operationResults,
          ...results.map((item) => item.result),
        ],
        latestOperationResultCount: results.length,
        phaseContinuity: conversation.pendingOperationRound.phaseContinuity,
        pendingOperationRound: undefined,
      };
      continue;
    }
    if (conversation.pendingSubmissionRound) {
      assertActualModel(
        command.modelSelection,
        conversation.pendingSubmissionRound.actualIdentity,
      );
      let product = command.codec.decode(
        conversation.pendingSubmissionRound.submission,
        envelope,
      );
      command.executionPermit.assertActive();
      const terminalOperation = command.codec.terminalOperation?.(product, envelope);
      if (terminalOperation) {
        const terminalEnvelope = {
          ...envelope,
          operationAuthority: command.operationAuthority,
        };
        const [completed] = await performOperationBatch(
          command,
          terminalEnvelope,
          [terminalOperation],
        );
        if (!completed) throw new Error("BTCC terminal operation returned no result");
        const operationBinding = await command.store.appendOperationResults({
          binding: conversation.binding,
          results: [completed],
          pendingSubmissionRound: conversation.pendingSubmissionRound,
        });
        conversation = {
          ...conversation,
          binding: trackCheckpoint(operationBinding, checkpointAdvanced),
          operationResults: [...conversation.operationResults, completed.result],
        };
        product = command.codec.acceptTerminalOperation
          ? command.codec.acceptTerminalOperation(product, completed.result)
          : product;
      }
      const acceptedBinding = await command.store.acceptPhaseProduct({
        binding: conversation.binding,
        product,
      });
      checkpointAdvanced(acceptedBinding);
      command.executionPermit.assertActive();
      return product;
    }
    await command.activity?.modelRoundWaiting?.({
      turnId: conversation.binding.turnId,
      semanticState: conversation.binding.semanticState,
      checkpointId: conversation.binding.checkpointId,
    });
    const round = await command.model.runRound(
      envelope,
      command.executionPermit.signal,
    );
    command.executionPermit.assertActive();
    if (round.kind === "interruption") {
      throw new OperationalInterruptionError(
        round.code,
        envelope.binding,
        round.activation,
        round.diagnosticMessage
          ? new Error(round.diagnosticMessage)
          : undefined,
        round.diagnostic,
      );
    }
    assertActualModel(command.modelSelection, round.actualIdentity);
    if (round.kind === "operation_requests") {
      conversation = {
        ...conversation,
        binding: trackCheckpoint(
          await command.store.appendOperationRound({
            binding: conversation.binding,
            envelope,
            requests: round.requests,
            phaseContinuity: round.phaseContinuity,
            actualIdentity: round.actualIdentity,
          }),
          checkpointAdvanced,
        ),
        pendingOperationRound: round,
      };
      providerCorrection = undefined;
      if (round.phaseContinuity) {
        await command.activity?.publish({
          turnId: conversation.binding.turnId,
          semanticState: conversation.binding.semanticState,
          activityId: phaseActivityId(conversation.binding),
          activity: round.phaseContinuity.publicActivity,
        });
      }
      continue;
    }
    const proposal = decodePhaseSubmissionProposal(command, round.submission, envelope);
    if (proposal.kind === "rejected") {
      conversation = {
        ...conversation,
        binding: trackCheckpoint(
          await command.store.appendProviderProductRejection({
            binding: conversation.binding,
            envelope,
            submission: round.submission,
            publicActivity: round.publicActivity,
            actualIdentity: round.actualIdentity,
            correction: proposal.correction,
          }),
          checkpointAdvanced,
        ),
        providerCorrection: proposal.correction,
      };
      providerCorrection = proposal.correction;
      continue;
    }
    conversation = {
      ...conversation,
      binding: trackCheckpoint(
        await command.store.appendPhaseSubmission({
          binding: conversation.binding,
          envelope,
          submission: round.submission,
          publicActivity: round.publicActivity,
          actualIdentity: round.actualIdentity,
        }),
        checkpointAdvanced,
      ),
      pendingSubmissionRound: round,
    };
    if (round.publicActivity) {
      await command.activity?.publish({
        turnId: conversation.binding.turnId,
        semanticState: conversation.binding.semanticState,
        activityId: phaseActivityId(conversation.binding),
        activity: round.publicActivity,
      });
    }
  }
}

function trackCheckpoint(
  binding: PhaseEnvelope["binding"],
  checkpointAdvanced: (binding: PhaseEnvelope["binding"]) => void,
): PhaseEnvelope["binding"] {
  checkpointAdvanced(binding);
  return binding;
}

function decodePhaseSubmissionProposal<Product>(
  command: PhaseConversationCommand<Product>,
  submission: unknown,
  envelope: PhaseEnvelope,
):
  | { kind: "accepted"; product: Product }
  | { kind: "rejected"; correction: ProviderCorrection } {
  try {
    return { kind: "accepted", product: command.codec.decode(submission, envelope) };
  } catch (error) {
    if (process.env.BUTLER_OPERATIONAL_DIAGNOSTICS === "1") {
      console.error(
        JSON.stringify({
          event: "btcc_phase_submission_rejected",
          phase: envelope.phase,
          checkpointId: envelope.binding.checkpointId,
          cause: {
            name: error instanceof Error ? error.name : "UnknownError",
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    }
    return {
      kind: "rejected",
      correction: {
        kind: "previous_provider_product_rejected",
        code: "provider_phase_submission_invalid",
        diagnosticMessage: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function assembleEnvelope<Product>(
  command: PhaseConversationCommand<Product>,
  conversation: PhaseConversationSnapshot<Product>,
  providerCorrection: ProviderCorrection | undefined,
): PhaseEnvelope {
  const operationResults = conversation.operationResults.map((result) =>
    normalizeOperationResult(
      result,
      conversation.binding,
      command.modelSelection,
    ),
  );
  const operationAuthority = phaseOperationAuthority(
    command.phaseContract.operationSurface,
    command.operationAuthority,
    operationResults,
  );
  return {
    binding: conversation.binding,
    ...command.phaseContract,
    modelSelection: command.modelSelection,
    context: command.context,
    operationAuthority,
    operationResults,
    latestOperationResultCount: conversation.latestOperationResultCount,
    ...(conversation.phaseContinuity
      ? { phaseContinuity: conversation.phaseContinuity }
      : {}),
    submissionSchema: command.codec.submissionSchema,
    ...(providerCorrection
      ? { providerCorrection }
      : {}),
  };
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
