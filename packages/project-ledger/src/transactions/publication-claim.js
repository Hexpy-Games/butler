import { existsSync, rmSync } from "node:fs";
import { mutationLockPath, readClaim, tryCreateClaim } from "../mutation-lock.js";

export class ProjectLedgerPublicationClaimConflictError extends Error {
  constructor(claim, expected) {
    super("Project Ledger canonical root is claimed by another publication");
    this.name = "ProjectLedgerPublicationClaimConflictError";
    this.code = "project_ledger_publication_claim_conflict";
    this.claimedPublicationId = claim.publicationId;
    this.requestedPublicationId = expected.publicationId;
    this.claimPath = expected.claimPath;
  }
}

export class ProjectLedgerMutationClaimConflictError extends Error {
  constructor(claim, expected) {
    super("Project Ledger canonical root is claimed by an ordinary mutation");
    this.name = "ProjectLedgerMutationClaimConflictError";
    this.code = "project_ledger_mutation_claim_conflict";
    this.claimId = claim.claimId;
    this.claimPath = expected.claimPath;
  }
}

export function publicationClaimPath(_journalPath, canonicalRoot) {
  return mutationLockPath(canonicalRoot);
}

export function acquirePublicationClaim(path, transaction) {
  if (!tryCreateClaim(path, claimIdentity(transaction))) {
    assertPublicationClaim(path, transaction);
  }
}

export function assertPublicationClaim(path, transaction) {
  if (!existsSync(path)) throw new Error("Project Ledger publication claim is missing");
  const claim = readClaim(path);
  const expected = claimIdentity(transaction);
  if (claim.schema === "project-ledger.mutation-claim.v1") {
    throw new ProjectLedgerMutationClaimConflictError(claim, expected);
  }
  if (claim.publicationId !== expected.publicationId ||
    claim.canonicalRoot !== expected.canonicalRoot ||
    claim.baseSha256 !== expected.baseSha256) {
    throw new ProjectLedgerPublicationClaimConflictError(claim, expected);
  }
}

export function releasePublicationClaim(path, transaction) {
  assertPublicationClaim(path, transaction);
  rmSync(path, { recursive: true });
}

export function reconcilePublicationClaim(path, transaction, referenced) {
  if (!referenced) {
    if (!existsSync(path)) return;
    assertPublicationClaim(path, transaction);
    rmSync(path, { recursive: true, force: true });
    return;
  }
  if (!existsSync(path)) {
    if (!tryCreateClaim(path, claimIdentity(transaction))) {
      assertPublicationClaim(path, transaction);
    }
  }
  assertPublicationClaim(path, transaction);
}

function claimIdentity(transaction) {
  return {
    schema: "project-ledger.publication-claim.v1",
    claimId: transaction.publicationId,
    publicationId: transaction.publicationId,
    canonicalRoot: transaction.canonicalRoot,
    baseSha256: transaction.base.sourceSha256,
  };
}
