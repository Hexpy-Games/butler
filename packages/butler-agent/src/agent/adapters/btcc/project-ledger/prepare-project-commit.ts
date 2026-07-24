import { join } from "node:path";
import {
  assertLogicalLedgerMutationId,
  contentRef,
  createLogicalLedgerBundle,
  planningCandidateBundleEntries,
  stableJson,
  type WorkLedgerCommit,
} from "../../../btcc/index.ts";
import type {
  PreparedProjectCommit,
  PrepareProjectCommitInput,
  ProjectLedgerCorePublication,
} from "./contracts.ts";
import { loadProjectLedgerCore } from "./project-ledger-core.ts";
import { loadProjectProgram, materializeProjectProgram } from "./materialize-program.ts";
import { reduceProjectProgram } from "./reduce-program.ts";
import { resolveCanonicalSpecCatalog } from "./canonical-spec-resolver.ts";

export async function prepareProjectCommit(
  stagingRoot: string,
  input: PrepareProjectCommitInput,
): Promise<PreparedProjectCommit> {
  const core = await loadProjectLedgerCore();
  const programId = programIdOf(input);
  const current = loadProjectProgram(core, input.projectRoot, programId);
  assertLogicalLedgerMutationId(input.commit, current);
  const canonicalSpecs = input.commit.mutation.kind === "bind_program"
    ? resolveCanonicalSpecCatalog(core, input.projectRoot)
    : [];
  const availableSpecs = input.commit.mutation.kind === "bind_program"
    ? canonicalSpecs.map(({ body: _body, ...spec }) => spec)
    : current?.availableSpecs ?? [];
  const governingSpecs = input.commit.mutation.kind === "bind_program"
    ? selectGoverningSpecs(
      canonicalSpecs,
      input.commit.mutation.product.goalContract.governingSpecLogicalIds,
    )
    : current?.governingSpecs ?? [];
  const program = reduceProjectProgram(
    current,
    input.commit,
    availableSpecs,
    governingSpecs,
  );
  const paths = publicationPaths(stagingRoot, input.commit.mutationId);
  const prepared = core.prepareProjectLedgerPublication({
    publicationId: input.commit.mutationId,
    canonicalRoot: input.expectedBase.projectRoot,
    candidateRoot: paths.candidateRoot,
    journalPath: paths.journalPath,
    expectedBase: input.expectedBase,
    materialize(candidateRoot: string) {
      materializeProjectProgram(core, candidateRoot, program, input.commit);
      const reloaded = loadProjectProgram(core, candidateRoot, programId);
      if (!reloaded || stableJson(reloaded) !== stableJson(program)) {
        throw new Error("Prepared Project Work Ledger manifest changed");
      }
    },
  }) as ProjectLedgerCorePublication;
  const commitRef = contentRef("project-work-ledger-commit", input.commit);
  const logicalBundle = createLogicalLedgerBundle({ commit: input.commit, previous: current, next: program });
  const provenance = publicationProvenance(input.commit, commitRef);
  return {
    program,
    publication: {
      schema: "butler.btcc-project-ledger-publication.v1",
      canonicalBase: input.expectedBase,
      ledgerId: program.ledgerId,
      programId,
      logicalBundleRef: logicalBundle.ref,
      reviewedBundleRef: provenance.reviewedBundleRef,
      planningReviewRef: provenance.planningReviewRef,
      stagedLedgerRoot: prepared.candidateRoot,
      corePublication: prepared,
      manifestSha256: logicalBundle.nextManifest.contentHash,
      entries: provenance.entries,
    },
  };
}

function selectGoverningSpecs<T extends { logicalId: string }>(
  catalog: T[],
  logicalIds: string[],
): T[] {
  const byLogicalId = new Map(catalog.map((spec) => [spec.logicalId, spec]));
  return logicalIds.map((logicalId) => {
    const spec = byLogicalId.get(logicalId);
    if (!spec) throw new Error(`Canonical governing Spec ${logicalId} is unavailable`);
    return spec;
  });
}

function publicationProvenance(
  commit: WorkLedgerCommit,
  mutationRef: { id: string; sha256: string },
) {
  if (commit.mutation.kind !== "install_reviewed_plan") {
    return {
      reviewedBundleRef: mutationRef,
      planningReviewRef: mutationRef,
      entries: [{
        recordKind: `ledger_mutation.${commit.mutation.kind}`,
        ref: mutationRef,
        semanticBytes: stableJson(commit),
      }],
    };
  }
  const { candidate, review } = commit.mutation.product;
  if (review.verdict !== "accepted" ||
    review.candidateRef.id !== candidate.ref.id ||
    review.candidateRef.sha256 !== candidate.ref.sha256 ||
    review.reviewedBundleRef.id !== candidate.bundle.ref.id ||
    review.reviewedBundleRef.sha256 !== candidate.bundle.ref.sha256) {
    throw new Error("Project Ledger publication is not the exact accepted Planning bundle");
  }
  const recordRefs = candidate.bundle.recordRefs;
  const entries = planningCandidateBundleEntries(candidate);
  if (recordRefs.length !== entries.length ||
    new Set(recordRefs.map((ref) => `${ref.id}:${ref.sha256}`)).size !== entries.length) {
    throw new Error("Accepted Planning bundle inventory is not one-to-one");
  }
  for (let index = 0; index < entries.length; index += 1) {
    const ref = recordRefs[index]!;
    const entry = entries[index]!;
    if (ref.id !== entry.ref.id || ref.sha256 !== entry.ref.sha256) {
      throw new Error("Accepted Planning bundle entry order or identity changed");
    }
  }
  return {
    reviewedBundleRef: candidate.bundle.ref,
    planningReviewRef: review.ref,
    entries: entries.map((entry) => ({ ...entry })),
  };
}

function programIdOf(input: PrepareProjectCommitInput): string {
  const mutation = input.commit.mutation;
  if (mutation.kind === "bind_program") return mutation.product.authority.managedBinding.programId;
  if (mutation.kind === "install_reviewed_plan") return mutation.product.candidate.programId;
  return mutation.cursor.programId;
}

function publicationPaths(stagingRoot: string, mutationId: string) {
  return {
    candidateRoot: join(stagingRoot, "candidates", mutationId),
    journalPath: join(stagingRoot, "journals", `${mutationId}.json`),
  };
}
