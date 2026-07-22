import type { ContentRef } from "../core/index.ts";

export type DeferredContinuationCandidate = {
  candidateId: string;
  ledgerId: string;
  programId: string;
  expectedManifestRevision: number;
  baseManifestHash: string;
  sourceTurnId: string;
  originalGoalContractRef: ContentRef;
  anchorRef: ContentRef;
  blockerRef: ContentRef;
};

export type ContinuationBinding =
  | { kind: "new_request"; inboxId: string; ref: ContentRef }
  | {
      kind: "deferred_goal";
      inboxId: string;
      ref: ContentRef;
      candidateId: string;
      ledgerId: string;
      programId: string;
      expectedManifestRevision: number;
      baseManifestHash: string;
      sourceTurnId: string;
      originalGoalContractRef: ContentRef;
      anchorRef: ContentRef;
    };
