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

export type OpeningContinuationProduct = {
  kind: "opening_continuation";
  route: "assisted" | "managed";
  fulfillment: OpeningFulfillment;
  projection: {
    ref: ContentRef;
    summary: string;
    rationale: string;
    nextStep: string;
    contentSha256: string;
  };
};

export type OpeningWorkCancellationProduct = {
  kind: "opening_work_cancellation";
  route: "managed";
  candidate: import("../../continuation/index.ts").ContinuationCandidate;
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
    | "managed_effect_or_artifact";
};

export type OpeningRequiredResultKind =
  | "response_content"
  | "current_observation"
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
      requiredResultKind: "current_observation";
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
      requiredResultKind: "current_observation";
    }
  | {
      kind: "managed_continuation";
      requiredResultKind: Exclude<
        OpeningRequiredResultKind,
        "response_content" | "current_observation"
      >;
    }
);
