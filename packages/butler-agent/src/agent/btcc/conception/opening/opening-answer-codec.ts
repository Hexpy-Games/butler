import type { PhaseCodec } from "../../core/index.ts";
import { contentRef, digest } from "../../core/index.ts";
import type {
  OpeningContinuationProduct,
  OpeningProduct,
} from "./contracts.ts";
import { decodeOpeningAnswer } from "./decode-opening-answer.ts";
import { openingSubmissionSchema } from "../submission-schemas.ts";

export const openingAnswerCodec: PhaseCodec<OpeningProduct> = {
  submissionSchema: openingSubmissionSchema,
  decode(submission, envelope) {
    if (
      isRecord(submission) &&
      (submission.kind === "assisted_continuation" ||
        submission.kind === "managed_continuation")
    ) {
      return decodeOpeningContinuation(submission, envelope.binding.turnId);
    }
    return decodeOpeningAnswerProduct(submission, envelope);
  },
};

export function decodeOpeningAnswerProduct(
  submission: unknown,
  envelope: Parameters<PhaseCodec<OpeningProduct>["decode"]>[1],
) {
    const { answer, route, personalizationRefs } = decodeOpeningAnswer(submission, envelope);
    const goalBody = {
      originalMessageId: envelope.context.originalMessageId,
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
  turnId: string,
): OpeningContinuationProduct {
  if (!isNonEmptyString(value.message)) {
    throw new Error("Opening continuation message is invalid");
  }
  const body = {
    turnId,
    content: value.message,
    contentSha256: digest(value.message),
  };
  return {
    kind: "opening_continuation",
    route: value.kind === "assisted_continuation" ? "assisted" : "managed",
    projection: {
      ref: contentRef("opening-projection", body),
      content: value.message,
      contentSha256: body.contentSha256,
    },
  };
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
