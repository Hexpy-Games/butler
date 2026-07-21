import type { AdmittedModelSelection } from "../../contracts.ts";
import type {
  ContentRef,
  OpeningContext,
  PhaseConversationStore,
  PhaseRunBinding,
  SelectedModel,
} from "../../core/index.ts";

export type OpeningAnswerProduct = {
  kind: "opening_answer";
  route: "direct";
  goalContract: {
    ref: ContentRef;
    originalMessageId: string;
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
  };
  outputGuard: {
    ref: ContentRef;
    draftRef: ContentRef;
    responseVerdict: "responsive" | "truthfully_limited";
    personalizationVerdicts: PersonalizationVerdict[];
    verdict: "accepted";
  };
  finalPayload: {
    ref: ContentRef;
    draftRef: ContentRef;
    guardReceiptRef: ContentRef;
    contentSha256: string;
    route: "direct";
    disposition: "answered";
    content: string;
  };
};

export type OpeningContinuationProduct = {
  kind: "opening_continuation";
  route: "managed";
  projection: {
    ref: ContentRef;
    content: string;
    contentSha256: string;
  };
};

export type OpeningProduct = OpeningAnswerProduct | OpeningContinuationProduct;

export type PersonalizationApplication = {
  ref: string;
  decision: "applied" | "not_applicable";
};

export type PersonalizationVerdict = {
  ref: string;
  verdict: "faithful_and_public_safe";
};

export type DirectAnswerSubmission = {
  kind: "direct_answer";
  interpretedIntent: string;
  requiredOutcome: string;
  requiredOutcomeResolution: "fulfilled" | "truthfully_limited";
  nonGoals: string[];
  answer: string;
  personalizationApplications: PersonalizationApplication[];
  guard: {
    responseVerdict: "responsive" | "truthfully_limited";
    personalizationVerdicts: PersonalizationVerdict[];
    verdict: "accepted";
  };
};

export type OpeningContinuationSubmission = {
  kind: "opening_continuation";
  message: string;
};

export type OpenConceptionCommand = {
  binding: PhaseRunBinding;
  modelSelection: AdmittedModelSelection;
  context: OpeningContext;
  conversations: PhaseConversationStore;
  model: SelectedModel;
};
