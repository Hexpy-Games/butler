import type {
  ContentRef,
} from "../../core/index.ts";

export type OpeningAnswerProduct = {
  kind: "opening_answer";
  route: "direct" | "assisted";
  fulfillment: OpeningFulfillment;
  goalContract: {
    ref: ContentRef;
    originalMessageId: string;
    requestObligation: string;
    interpretedIntent: string;
    requiredOutcome: string;
    personalizationRefs: string[];
    nonGoals: string[];
  };
  authority: { ref: ContentRef; effectsForbidden: true };
  continuationBinding: { kind: "new_request"; bindingId: string };
  outputDraft: {
    ref: ContentRef;
    goalContractRef: ContentRef;
    authorityRef: ContentRef;
    content: string;
    contentSha256: string;
    responseCoverage: {
      requiredOutcome: string;
      resolution: "fulfilled" | "truthfully_limited";
      contentPartId: string;
    };
    personalizationApplications: PersonalizationApplication[];
    publicClaims: PublicClaim[];
  };
  finalPayload: {
    ref: ContentRef;
    draftRef: ContentRef;
    contentSha256: string;
    route: "direct" | "assisted";
    disposition: "answered";
    content: string;
  };
};

type OpeningContinuationBase = {
  kind: "opening_continuation";
  fulfillment: OpeningFulfillment;
  projection: {
    ref: ContentRef;
    summary: string;
    rationale: string;
    nextStep: string;
    contentSha256: string;
  };
};

export type OpeningContinuationProduct =
  | (OpeningContinuationBase & {
      continuationMode: "assisted_request";
      route: "assisted";
    })
  | (OpeningContinuationBase & {
      continuationMode: "managed_request";
      route: "managed";
    })
  | (OpeningContinuationBase & {
      continuationMode: "managed_program";
      route: "managed";
      continuationProposal: {
        candidateId: string;
        sourceTurnId: string;
        programId: string;
      };
    })
  | (OpeningContinuationBase & {
      continuationMode: "managed_finalization";
      route: "managed";
      continuationProposal: {
        candidateId: string;
        sourceTurnId: string;
        programId: string;
      };
    });

export type OpeningWorkCancellationProduct = {
  kind: "opening_work_cancellation";
  route: "managed";
  candidate: Exclude<
    import("../../continuation/index.ts").ContinuationCandidate,
    { continuationKind: "managed_finalization" }
  >;
  cancellation: {
    ref: ContentRef;
    kind: "cancel_work";
    reason: string;
    sourceTurnId: string;
    programId: string;
  };
};

export type OpeningProduct =
  | OpeningAnswerProduct
  | OpeningContinuationProduct
  | OpeningWorkCancellationProduct;

export type OpeningFulfillment = {
  requestObligation: string;
  requiredResultKind: OpeningRequiredResultKind;
  completionMode:
    | "answer_only"
    | "bounded_observation_then_answer"
    | "bounded_local_effect_then_answer"
    | "managed_effect_or_artifact";
};

export type OpeningRequiredResultKind =
  | "response_content"
  | "current_observation"
  | "turn_local_effect"
  | "target_change"
  | "persistent_artifact"
  | "external_effect"
  | "durable_work";

export type PersonalizationApplication = {
  ref: string;
  decision: "applied" | "not_applicable";
};

export type PublicClaim = {
  claim: string;
  sourceRefs: ContentRef[];
};

type OpeningAnswerFields = {
  requestObligation: string;
  interpretedIntent: string;
  requiredOutcome: string;
  requiredOutcomeResolution: "fulfilled" | "truthfully_limited";
  nonGoals: string[];
  answer: string;
  personalizationApplications: PersonalizationApplication[];
  publicClaims: PublicClaim[];
};

export type OpeningAnswerSubmission = OpeningAnswerFields & (
  | { kind: "direct_answer"; requiredResultKind: "response_content" }
  | {
      kind: "assisted_answer";
      requiredResultKind: "current_observation" | "turn_local_effect";
    }
);

type OpeningContinuationFields = {
  requestObligation: string;
  summary: string;
  rationale: string;
  nextStep: string;
};

export type OpeningContinuationSubmission = OpeningContinuationFields & (
  | {
      kind: "assisted_continuation";
      requiredResultKind: "current_observation" | "turn_local_effect";
    }
  | {
      kind: "managed_continuation";
      requiredResultKind: Exclude<
        OpeningRequiredResultKind,
        "response_content" | "current_observation"
      >;
    }
  | {
      kind: "managed_program_continuation";
      requiredResultKind: "durable_work";
      continuationCandidateId: string;
    }
  | {
      kind: "managed_finalization_continuation";
      requiredResultKind: "durable_work";
      continuationCandidateId: string;
    }
);
