import { createHash } from "node:crypto";
import type {
  OpeningContext,
  PhaseCodec,
} from "../../core/index.ts";
import type {
  ContentRef,
  DirectAnswerSubmission,
  OpeningAnswerProduct,
  PersonalizationApplication,
} from "./contracts.ts";

export const openingAnswerCodec: PhaseCodec<OpeningAnswerProduct> = {
  decode(submission, envelope) {
    const answer = decodeDirectAnswer(submission);
    const expectedPersonalization = personalizationRefs(envelope.context);
    assertExactPersonalization(answer.personalizationApplications, expectedPersonalization);

    const goalBody = {
      originalMessageId: envelope.context.originalMessageId,
      interpretedIntent: answer.interpretedIntent,
      requiredOutcome: answer.requiredOutcome,
      personalizationRefs: expectedPersonalization,
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
    };
    const outputGuard = {
      ref: contentRef("guard", {
        draftRef: outputDraft.ref,
        ...answer.guard,
      }),
      draftRef: outputDraft.ref,
      ...answer.guard,
    };
    const finalPayloadBody = {
      turnId: envelope.binding.turnId,
      draftRef: outputDraft.ref,
      guardReceiptRef: outputGuard.ref,
      contentSha256: outputDraft.contentSha256,
      route: "direct",
      disposition: "answered",
      content: answer.answer,
    };

    return {
      kind: "opening_answer",
      route: "direct",
      goalContract,
      authority,
      continuationBinding: {
        kind: "new_request",
        bindingId: digest(`new-request\0${envelope.binding.turnId}`),
      },
      outputDraft,
      outputGuard,
      finalPayload: {
        ref: contentRef("payload", finalPayloadBody),
        draftRef: outputDraft.ref,
        guardReceiptRef: outputGuard.ref,
        contentSha256: outputDraft.contentSha256,
        route: "direct",
        disposition: "answered",
        content: answer.answer,
      },
    };
  },
};

function decodeDirectAnswer(value: unknown): DirectAnswerSubmission {
  if (!isRecord(value) || value.kind !== "direct_answer") {
    throw new Error("Opening submission must be a Direct answer");
  }
  if (
    !isNonEmptyString(value.interpretedIntent) ||
    !isNonEmptyString(value.requiredOutcome) ||
    !isNonEmptyString(value.answer) ||
    !Array.isArray(value.nonGoals) ||
    !value.nonGoals.every(isNonEmptyString) ||
    !Array.isArray(value.personalizationApplications) ||
    (value.requiredOutcomeResolution !== "fulfilled" &&
      value.requiredOutcomeResolution !== "truthfully_limited")
  ) {
    throw new Error("Opening Direct answer has an invalid structured product");
  }
  const applications = value.personalizationApplications.map(decodePersonalizationApplication);
  const guard = decodeGuard(value.guard, applications, value.requiredOutcomeResolution);
  return {
    kind: "direct_answer",
    interpretedIntent: value.interpretedIntent,
    requiredOutcome: value.requiredOutcome,
    requiredOutcomeResolution: value.requiredOutcomeResolution,
    nonGoals: value.nonGoals,
    answer: value.answer,
    personalizationApplications: applications,
    guard,
  };
}

function decodePersonalizationApplication(value: unknown): PersonalizationApplication {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.ref) ||
    (value.decision !== "applied" && value.decision !== "not_applicable")
  ) {
    throw new Error("Opening personalization application is invalid");
  }
  return { ref: value.ref, decision: value.decision };
}

function decodeGuard(
  value: unknown,
  applications: DirectAnswerSubmission["personalizationApplications"],
  resolution: DirectAnswerSubmission["requiredOutcomeResolution"],
): DirectAnswerSubmission["guard"] {
  if (
    !isRecord(value) ||
    value.verdict !== "accepted" ||
    !Array.isArray(value.personalizationVerdicts) ||
    (value.responseVerdict !== "responsive" &&
      value.responseVerdict !== "truthfully_limited")
  ) {
    throw new Error("Opening output guard is invalid");
  }
  const expectedResponseVerdict = resolution === "fulfilled"
    ? "responsive"
    : "truthfully_limited";
  if (value.responseVerdict !== expectedResponseVerdict) {
    throw new Error("Opening output guard does not match outcome coverage");
  }
  const personalizationVerdicts = value.personalizationVerdicts.map((item) => {
    if (
      !isRecord(item) ||
      !isNonEmptyString(item.ref) ||
      item.verdict !== "faithful_and_public_safe"
    ) {
      throw new Error("Opening personalization guard verdict is invalid");
    }
    return { ref: item.ref, verdict: "faithful_and_public_safe" as const };
  });
  if (
    JSON.stringify(personalizationVerdicts.map(({ ref }) => ref)) !==
    JSON.stringify(applications.map(({ ref }) => ref))
  ) {
    throw new Error("Opening output guard subjects do not match personalization applications");
  }
  return {
    responseVerdict: value.responseVerdict,
    personalizationVerdicts,
    verdict: "accepted",
  };
}

function personalizationRefs(context: OpeningContext): string[] {
  return [
    ...context.profileRefs,
    ...context.recentFeedbackRefs,
    ...context.mandatoryHotCacheRefs,
    ...context.optionalHotCacheRefs,
  ];
}

function assertExactPersonalization(
  applications: DirectAnswerSubmission["personalizationApplications"],
  expected: string[],
): void {
  const actual = applications.map((item) => item.ref);
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Opening answer did not account for the exact Butler context");
  }
}

function contentRef(kind: string, body: unknown): ContentRef {
  const sha256 = digest(JSON.stringify(body));
  return { id: digest(`btcc-${kind}.v1\0${sha256}`), sha256 };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
