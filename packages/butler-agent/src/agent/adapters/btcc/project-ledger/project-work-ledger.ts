import type {
  PrepareProjectCommitInput,
  PreparedProjectLedgerPublication,
  ProjectWorkLedgerPublicationAdapter,
} from "./contracts.ts";
import {
  ProjectLedgerHeadConflictError,
  ProjectLedgerMutationClaimConflictError,
  ProjectLedgerPublicationClaimConflictError,
} from "./contracts.ts";
import { exchangeCompleteRoots } from "../../../../foundation/atomic-root-exchange.ts";
import { loadProjectLedgerCore } from "./project-ledger-core.ts";
import { observeProjectLedgerHead } from "./observe-project-ledger.ts";
import { prepareProjectCommit } from "./prepare-project-commit.ts";
import { loadProjectProgram } from "./materialize-program.ts";
import { reconcileOrphanedPublications } from "./reconcile-publications.ts";
import {
  resolveCanonicalSpecCatalog,
  resolveCanonicalSpecRevisions,
} from "./canonical-spec-resolver.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

class DefaultProjectWorkLedgerPublicationAdapter
  implements ProjectWorkLedgerPublicationAdapter {
  constructor(private readonly stagingRoot: string) {}

  observeCanonicalHead(projectRoot: string) {
    return observeProjectLedgerHead(projectRoot);
  }

  async listCanonicalSpecs(projectRoot: string) {
    return resolveCanonicalSpecCatalog(await loadProjectLedgerCore(), projectRoot);
  }

  async resolveCanonicalSpecs(projectRoot: string, logicalIds: readonly string[]) {
    return resolveCanonicalSpecRevisions(
      await loadProjectLedgerCore(),
      projectRoot,
      logicalIds,
    );
  }

  async prepareCommit(input: PrepareProjectCommitInput) {
    assertSameHead(input.expectedBase, await this.observeCanonicalHead(input.projectRoot));
    try {
      return await prepareProjectCommit(this.stagingRoot, input);
    } catch (error) {
      if (isMutationClaimConflict(error)) {
        const claimId = readString(error, "claimId");
        const claimPath = readString(error, "claimPath");
        if (!claimId || !claimPath) {
          throw new Error("Project Ledger mutation conflict has no exact claim identity", {
            cause: error,
          });
        }
        throw new ProjectLedgerMutationClaimConflictError(
          error, input.projectRoot, claimPath, input.expectedBase, claimId,
        );
      }
      if (isPublicationClaimConflict(error)) {
        const claimedPublicationId = readString(error, "claimedPublicationId");
        if (!claimedPublicationId) {
          throw new Error("Project Ledger claim conflict has no exact winning publication", {
            cause: error,
          });
        }
        throw new ProjectLedgerPublicationClaimConflictError(
          error,
          input.projectRoot,
          readString(error, "claimPath") ?? "",
          input.expectedBase,
          claimedPublicationId,
        );
      }
      throw error;
    }
  }

  async loadProgram(projectRoot: string, programId: string) {
    return loadProjectProgram(await loadProjectLedgerCore(), projectRoot, programId);
  }

  async listDeferredPrograms(projectRoot: string) {
    const core = await loadProjectLedgerCore();
    const ids = core.buildIndex(projectRoot).records
      .filter((record) => record.kind === "reference" && record.id.startsWith("BTCC-PROGRAM-"))
      .map((record) => record.id.slice("BTCC-PROGRAM-".length));
    const programs = ids.map((programId) => loadProjectProgram(core, projectRoot, programId))
      .filter((program): program is NonNullable<typeof program> => Boolean(program?.activeDeferral));
    return programs.sort((left, right) => left.programId.localeCompare(right.programId));
  }

  observePublicationState(publicationId: string): "held" | "released" | "promoted" {
    const path = join(this.stagingRoot, "journals", `${publicationId}.json`);
    if (!existsSync(path)) return "released";
    const journal = JSON.parse(readFileSync(path, "utf8")) as { status?: string };
    return journal.status === "promoted" || journal.status === "observed"
      ? "promoted" : "held";
  }

  observeMutationClaimState(
    claimPath: string,
    claimId: string,
  ): "held_exact" | "held_other" | "released" {
    if (!existsSync(claimPath)) return "released";
    try {
      const claim = JSON.parse(readFileSync(claimPath, "utf8")) as {
        schema?: string;
        claimId?: string;
      };
      return claim.schema === "project-ledger.mutation-claim.v1" && claim.claimId === claimId
        ? "held_exact"
        : "held_other";
    } catch {
      return "held_other";
    }
  }

  async reconcileOrphanedPublications(referencedPublicationIds: string[]) {
    reconcileOrphanedPublications(
      await loadProjectLedgerCore(),
      this.stagingRoot,
      new Set(referencedPublicationIds),
    );
  }

  async abort(publication: PreparedProjectLedgerPublication) {
    const core = await loadProjectLedgerCore();
    core.abortProjectLedgerPublication(publication.corePublication);
  }

  async promoteAndObserve(publication: PreparedProjectLedgerPublication) {
    const core = await loadProjectLedgerCore();
    core.promoteProjectLedgerPublication(
      publication.corePublication,
      exchangeCompleteRoots,
    );
    core.observeProjectLedgerPromotion(publication.corePublication);
  }
}

function readString(error: unknown, key: string): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function isPublicationClaimConflict(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    error.code === "project_ledger_publication_claim_conflict";
}

function isMutationClaimConflict(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    error.code === "project_ledger_mutation_claim_conflict";
}

function assertSameHead(
  expected: PreparedProjectLedgerPublication["canonicalBase"],
  actual: PreparedProjectLedgerPublication["canonicalBase"],
): void {
  if (
    expected.projectRoot !== actual.projectRoot ||
    expected.sourceSha256 !== actual.sourceSha256 ||
    expected.sourceFileCount !== actual.sourceFileCount
  ) {
    throw new ProjectLedgerHeadConflictError(expected, actual);
  }
}

export function createProjectWorkLedgerPublicationAdapter(input: {
  stagingRoot: string;
}): ProjectWorkLedgerPublicationAdapter {
  return new DefaultProjectWorkLedgerPublicationAdapter(input.stagingRoot);
}
