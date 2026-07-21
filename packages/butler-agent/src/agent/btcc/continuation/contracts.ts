import type { ContentRef } from "../core/index.ts";

export type DeferredContinuationCandidate = {
  candidateId: string;
  ledgerId: string;
  programId: string;
  expectedManifestRevision: number;
  sourceTurnId: string;
  originalGoalContractRef: ContentRef;
  anchorRef: ContentRef;
  blockerRef: ContentRef;
};

export type ContinuationBinding =
  | { kind: "new_request"; ref: ContentRef }
  | {
      kind: "deferred_goal";
      ref: ContentRef;
      candidateId: string;
      ledgerId: string;
      programId: string;
      expectedManifestRevision: number;
      sourceTurnId: string;
      originalGoalContractRef: ContentRef;
      anchorRef: ContentRef;
    };
