import type { BtccPersistenceTypes, WorkLedgerCommit } from "../../../btcc/gateway-api.ts";

export type ReviewedPlanningPublication =
  BtccPersistenceTypes["planningAcceptedProduct"];
export type ProjectManagedProgram = BtccPersistenceTypes["managedProgramState"];

export type ProjectLedgerHead = {
  schema: "butler.btcc-project-ledger-head.v1";
  projectRoot: string;
  sourceSha256: string;
  sourceFileCount: number;
  storageSha256: string;
  storageEntryCount: number;
};

export type PreparedProjectLedgerEntry = {
  recordKind: string;
  ref: { id: string; sha256: string };
  semanticBytes: string;
};

export type PreparedProjectLedgerPublication = {
  schema: "butler.btcc-project-ledger-publication.v1";
  canonicalBase: ProjectLedgerHead;
  ledgerId: string;
  programId: string;
  logicalBundleRef: { id: string; sha256: string };
  reviewedBundleRef: { id: string; sha256: string };
  planningReviewRef: { id: string; sha256: string };
  stagedLedgerRoot: string;
  corePublication: ProjectLedgerCorePublication;
  manifestSha256: string;
  entries: PreparedProjectLedgerEntry[];
};

export type PreparedProjectCommit = {
  publication: PreparedProjectLedgerPublication;
  program: ProjectManagedProgram;
};

export type ProjectLedgerCorePublication = {
  schema: "project-ledger.prepared-publication.v1";
  publicationId: string;
  canonicalRoot: string;
  candidateRoot: string;
  journalPath: string;
  claimPath: string;
  base: ProjectLedgerHead;
  candidateHead: ProjectLedgerHead;
};

export type PrepareProjectCommitInput = {
  projectRoot: string;
  expectedBase: ProjectLedgerHead;
  commit: WorkLedgerCommit;
};

export interface ProjectWorkLedgerPublicationAdapter {
  observeCanonicalHead(projectRoot: string): Promise<ProjectLedgerHead>;
  prepareCommit(input: PrepareProjectCommitInput): Promise<PreparedProjectCommit>;
  loadProgram(projectRoot: string, programId: string): Promise<ProjectManagedProgram | null>;
  listDeferredPrograms(projectRoot: string): Promise<ProjectManagedProgram[]>;
  observePublicationState(publicationId: string): "held" | "released" | "promoted";
  observeMutationClaimState(
    claimPath: string,
    claimId: string,
  ): "held_exact" | "held_other" | "released";
  reconcileOrphanedPublications(referencedPublicationIds: string[]): Promise<void>;
  abort(publication: PreparedProjectLedgerPublication): Promise<void>;
  promoteAndObserve(
    publication: PreparedProjectLedgerPublication,
  ): Promise<void>;
}

export class ProjectLedgerPublicationClaimConflictError extends Error {
  readonly code = "project_ledger_publication_claim_conflict";

  constructor(
    override readonly cause: unknown,
    readonly projectRoot: string,
    readonly claimPath: string,
    readonly expectedBase: ProjectLedgerHead,
    readonly claimedPublicationId: string,
  ) {
    super("Canonical Project Ledger is owned by another pending publication");
    this.name = "ProjectLedgerPublicationClaimConflictError";
  }
}

export class ProjectLedgerMutationClaimConflictError extends Error {
  readonly code = "project_ledger_mutation_claim_conflict";

  constructor(
    override readonly cause: unknown,
    readonly projectRoot: string,
    readonly claimPath: string,
    readonly expectedBase: ProjectLedgerHead,
    readonly claimId: string,
  ) {
    super("Canonical Project Ledger is owned by an ordinary mutation");
    this.name = "ProjectLedgerMutationClaimConflictError";
  }
}

export class ProjectLedgerHeadConflictError extends Error {
  constructor(
    readonly expected: ProjectLedgerHead,
    readonly actual: ProjectLedgerHead,
  ) {
    super("Canonical Project Ledger head changed after Planning review");
    this.name = "ProjectLedgerHeadConflictError";
  }
}
