import type { PhaseCodec } from "../../core/index.ts";
import { contentRef, digest, stableJson } from "../../core/index.ts";
import type {
  OpeningContinuationProduct,
  OpeningProduct,
} from "./contracts.ts";
import { decodeOpeningAnswer } from "./decode-opening-answer.ts";
import { openingSubmissionSchemaFor } from "../submission-schemas.ts";
import { completionModeFor, isManagedResultKind } from "./fulfillment.ts";

export function openingAnswerCodec(
  continuationCandidateIds: readonly string[],
): PhaseCodec<OpeningProduct> {
  return {
  submissionSchema: openingSubmissionSchemaFor(continuationCandidateIds),
  decode(submission, envelope) {
    if (
      isRecord(submission) &&
      (submission.kind === "assisted_continuation" ||
        submission.kind === "managed_continuation" ||
        submission.kind === "managed_program_continuation")
    ) {
      return decodeOpeningContinuation(submission, envelope);
    }
    if (isRecord(submission) && submission.kind === "cancel_work") {
      return decodeWorkCancellation(submission, envelope);
    }
    return decodeOpeningAnswerProduct(submission, envelope);
  },
};
}

function decodeWorkCancellation(
  value: Record<string, unknown>,
  envelope: Parameters<PhaseCodec<OpeningProduct>["decode"]>[1],
): OpeningProduct {
  if (!isNonEmptyString(value.continuationCandidateId) || !isNonEmptyString(value.reason)) {
    throw new Error("Opening cancel_work decision is invalid");
  }
  const candidate = envelope.context.continuationCandidates?.find(
    (item) => item.candidateId === value.continuationCandidateId,
  );
  if (!candidate) throw new Error("Opening cancel_work selected an unavailable Program");
  const body = {
    kind: "cancel_work" as const,
    reason: value.reason,
    sourceTurnId: candidate.sourceTurnId,
    programId: candidate.programId,
  };
  return {
    kind: "opening_work_cancellation",
    route: "managed",
    candidate,
    cancellation: { ref: contentRef("work-cancellation", body), ...body },
  };
}

export function decodeOpeningAnswerProduct(
  submission: unknown,
  envelope: Parameters<PhaseCodec<OpeningProduct>["decode"]>[1],
) {
    const { answer, route, personalizationRefs } = decodeOpeningAnswer(submission, envelope);
    const goalBody = {
      originalMessageId: envelope.context.originalMessageId,
      requestObligation: answer.requestObligation,
      interpretedIntent: answer.interpretedIntent,
      requiredOutcome: answer.requiredOutcome,
      personalizationRefs,
      nonGoals: answer.nonGoals,
    };
    const goalContract = { ref: contentRef("goal", goalBody), ...goalBody };
    const authority = {
      ref: contentRef("authority", {
        turnId: envelope.binding.turnId,
        goalContractRef: goalContract.ref,
        effectsForbidden: true,
      }),
      effectsForbidden: true as const,
    };
    const outputDraftBody = {
      content: answer.answer,
      contentSha256: digest(answer.answer),
      responseCoverage: {
        requiredOutcome: answer.requiredOutcome,
        resolution: answer.requiredOutcomeResolution,
        contentPartId: digest(`btcc-content-part.v1\0${answer.answer}`),
      },
      personalizationApplications: answer.personalizationApplications,
      publicClaims: answer.publicClaims,
      goalContractRef: goalContract.ref,
      authorityRef: authority.ref,
    };
    const outputDraft = {
      ref: contentRef("draft", outputDraftBody),
      goalContractRef: goalContract.ref,
      authorityRef: authority.ref,
      content: answer.answer,
      contentSha256: outputDraftBody.contentSha256,
      responseCoverage: outputDraftBody.responseCoverage,
      personalizationApplications: answer.personalizationApplications,
      publicClaims: answer.publicClaims,
    };
    const finalPayloadBody = {
      turnId: envelope.binding.turnId,
      draftRef: outputDraft.ref,
      contentSha256: outputDraft.contentSha256,
      route,
      disposition: "answered",
      content: answer.answer,
    };

    return {
      kind: "opening_answer",
      route,
      fulfillment: {
        requestObligation: answer.requestObligation,
        requiredResultKind: answer.requiredResultKind,
        completionMode: completionModeFor(answer.requiredResultKind),
      },
      goalContract,
      authority,
      continuationBinding: {
        kind: "new_request",
        bindingId: digest(`new-request\0${envelope.binding.turnId}`),
      },
      outputDraft,
      finalPayload: {
        ref: contentRef("payload", finalPayloadBody),
        draftRef: outputDraft.ref,
        contentSha256: outputDraft.contentSha256,
        route,
        disposition: "answered",
        content: answer.answer,
      },
    } satisfies Extract<OpeningProduct, { kind: "opening_answer" }>;
}

function decodeOpeningContinuation(
  value: Record<string, unknown>,
  envelope: Parameters<PhaseCodec<OpeningProduct>["decode"]>[1],
): OpeningContinuationProduct {
  if (
    !isNonEmptyString(value.requestObligation) ||
    !isNonEmptyString(value.summary) ||
    !isNonEmptyString(value.rationale) ||
    !isNonEmptyString(value.nextStep)
  ) {
    throw new Error("Opening continuation decision is invalid");
  }
  const continuationMode = value.kind === "assisted_continuation"
    ? "assisted_request" as const
    : value.kind === "managed_program_continuation"
      ? "managed_program" as const
      : "managed_request" as const;
  const requiredResultKind = continuationMode === "assisted_request"
    ? requireAssistedResult(value.requiredResultKind)
    : requireManagedResult(value.requiredResultKind);
  const continuationProposal = continuationMode === "managed_program"
    ? requireContinuationProposal(value.continuationCandidateId, envelope)
    : undefined;
  const body = {
    turnId: envelope.binding.turnId,
    continuationMode,
    ...(continuationProposal ? { continuationProposal } : {}),
    requestObligation: value.requestObligation,
    requiredResultKind,
    completionMode: completionModeFor(requiredResultKind),
    summary: value.summary,
    rationale: value.rationale,
    nextStep: value.nextStep,
    contentSha256: digest(stableJson({
      summary: value.summary,
      rationale: value.rationale,
      nextStep: value.nextStep,
    })),
  };
  const common = {
    kind: "opening_continuation",
    fulfillment: {
      requestObligation: value.requestObligation,
      requiredResultKind,
      completionMode: completionModeFor(requiredResultKind),
    },
    projection: {
      ref: contentRef("opening-projection", body),
      summary: value.summary,
      rationale: value.rationale,
      nextStep: value.nextStep,
      contentSha256: body.contentSha256,
    },
  } as const;
  if (continuationMode === "assisted_request") {
    return { ...common, continuationMode, route: "assisted" };
  }
  if (continuationMode === "managed_program") {
    if (!continuationProposal) throw new Error("Managed Program proposal is missing");
    return {
      ...common,
      continuationMode,
      route: "managed",
      continuationProposal,
    };
  }
  return { ...common, continuationMode, route: "managed" };
}

function requireContinuationProposal(
  value: unknown,
  envelope: Parameters<PhaseCodec<OpeningProduct>["decode"]>[1],
) {
  if (!isNonEmptyString(value)) {
    throw new Error("Managed Program continuation requires a candidate id");
  }
  const candidate = envelope.context.continuationCandidates?.find(
    (item) => item.candidateId === value,
  );
  if (!candidate) {
    throw new Error("Opening selected an unavailable continuation candidate");
  }
  return {
    candidateId: candidate.candidateId,
    sourceTurnId: candidate.sourceTurnId,
    programId: candidate.programId,
  };
}

function requireAssistedResult(value: unknown): "current_observation" {
  if (value !== "current_observation") {
    throw new Error("Assisted Opening requires a current observation result");
  }
  return value;
}

function requireManagedResult(value: unknown) {
  if (!isManagedResultKind(value)) {
    throw new Error("Managed Opening requires an effect, artifact, or durable work result");
  }
  return value;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
