import type { Database } from "bun:sqlite";
import { ledgerManifestContentHash, type BtccRuntimeDependencies, type WorkLedgerCommit }
  from "../../../../btcc/index.ts";
import type { ProjectWorkLedgerPublicationAdapter } from "../../project-ledger/index.ts";
import {
  ProjectLedgerHeadConflictError,
  ProjectLedgerMutationClaimConflictError,
  ProjectLedgerPublicationClaimConflictError,
} from "../../project-ledger/index.ts";
import { digest, stableJson } from "../identity.ts";
import {
  LedgerContentionCheckpointResolution,
  type ContendedCheckpoint,
} from "./checkpoint-resolution.ts";
import {
  TimerContentionScanTrigger,
  type ContentionScanTrigger,
} from "./scan-trigger.ts";

type CommitInput = Parameters<BtccRuntimeDependencies["turns"]["commitTransition"]>[0];
type Conflict = ProjectLedgerHeadConflictError |
  ProjectLedgerMutationClaimConflictError |
  ProjectLedgerPublicationClaimConflictError;
type ProjectRuntime = {
  publications: ProjectWorkLedgerPublicationAdapter;
  resolveProjectRoot(projectRef: string): string;
};
type ContentionRow = ContendedCheckpoint & {
  contention_id: string;
  ledger_id: string;
  program_id: string;
  contention_kind: "mutation_claim" | "publication_claim" | "head_advanced";
  base_project_head_json: string;
  winning_publication_id: string;
  claim_path: string;
};

export class SqliteLedgerContentionRuntime {
  private readonly checkpoints: LedgerContentionCheckpointResolution;

  constructor(
    private readonly db: Database,
    private readonly project?: ProjectRuntime,
    private readonly scanTrigger: ContentionScanTrigger = new TimerContentionScanTrigger(),
  ) {
    this.checkpoints = new LedgerContentionCheckpointResolution(db);
  }

  relinquishBoundary(input: CommitInput, conflict: Conflict): string {
    const commit = "ledgerCommit" in input.transition ? input.transition.ledgerCommit : undefined;
    if (!commit) throw new Error("Ledger contention has no accepted Ledger boundary");
    const identity = ledgerIdentityOf(commit);
    const contentionId = digest(
      `btcc-ledger-contention.v1\0${input.turn.turnId}\0${input.turn.revision}\0${commit.mutationId}`,
    );
    const checkpoint = this.latestPendingSubmission(input.claim.checkpointId);
    const pendingJson = checkpoint?.pending_submission_json ?? stableJson({
      kind: "accepted_ledger_boundary",
      transition: input.transition,
    });
    const pendingRef = checkpoint?.pending_submission_ref ?? digest(pendingJson);
    const isPublication = conflict instanceof ProjectLedgerPublicationClaimConflictError;
    const isMutation = conflict instanceof ProjectLedgerMutationClaimConflictError;
    const winner = isPublication
      ? conflict.claimedPublicationId
      : isMutation ? conflict.claimId : "";
    const claimPath = isPublication || isMutation ? conflict.claimPath : "";
    const baseProjectHead = isPublication || isMutation
      ? conflict.expectedBase
      : conflict.expected;
    const activationKey = digest(
      `btcc-ledger-contention-activation.v1\0${contentionId}\0${winner ?? "head"}`,
    );
    this.db.transaction(() => {
      this.persistProjectBinding(commit);
      this.insertContention({
        contentionId,
        input,
        identity,
        pendingJson,
        pendingRef,
        checkpointRevision: checkpoint?.checkpoint_revision ?? input.claim.checkpointRevision,
        winner,
        contentionKind: isPublication
          ? "publication_claim"
          : isMutation ? "mutation_claim" : "head_advanced",
        claimPath,
        baseProjectHeadJson: stableJson(baseProjectHead),
        activationKey,
        baseManifestHash: ledgerManifestContentHash(input.turn.managed?.program ?? null, identity),
        baseManifestRevision: baseRevisionOf(commit),
      });
      this.relinquishStateClaim(input);
    })();
    return contentionId;
  }

  async waitUntilResolved(contentionId: string, signal?: AbortSignal): Promise<void> {
    while (this.status(contentionId) !== "closed") {
      await this.scan();
      if (this.status(contentionId) === "closed") return;
      await this.scanTrigger.wait(signal);
    }
  }

  async scan(): Promise<void> {
    if (!this.project) return;
    for (const row of this.ownedContentions()) {
      const binding = this.projectBinding(row.program_id);
      if (!binding) continue;
      const root = this.project.resolveProjectRoot(binding);
      const baseHead = JSON.parse(row.base_project_head_json) as {
        projectRoot: string;
        sourceSha256: string;
        sourceFileCount: number;
      };
      const canonicalHead = await this.project.publications.observeCanonicalHead(root);
      if (row.contention_kind === "head_advanced" ||
        canonicalHead.projectRoot !== baseHead.projectRoot ||
        canonicalHead.sourceSha256 !== baseHead.sourceSha256 ||
        canonicalHead.sourceFileCount !== baseHead.sourceFileCount) {
        this.checkpoints.supersedePendingSubmission(row);
      } else if (this.claimReleased(row)) {
        this.checkpoints.adoptPendingSubmission(row);
      }
    }
  }

  private insertContention(input: {
    contentionId: string;
    input: CommitInput;
    identity: { ledgerId: string; programId: string };
    pendingJson: string;
    pendingRef: string;
    checkpointRevision: number;
    winner: string;
    contentionKind: "mutation_claim" | "publication_claim" | "head_advanced";
    claimPath: string;
    baseProjectHeadJson: string;
    activationKey: string;
    baseManifestHash: string;
    baseManifestRevision: number;
  }): void {
    this.db.query(`
      INSERT INTO btcc_ledger_contentions (
        contention_id, turn_id, turn_revision, semantic_state,
        checkpoint_id, checkpoint_revision, pending_submission_ref,
        pending_submission_json, ledger_id, program_id,
        base_manifest_revision, base_manifest_hash, contention_kind,
        base_project_head_json, winning_publication_id, claim_path,
        winning_owner_id, owner_generation, activation_key, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'owned', ?)
      ON CONFLICT(turn_id, turn_revision) DO NOTHING
    `).run(
      input.contentionId, input.input.turn.turnId, input.input.turn.revision,
      input.input.turn.semanticState, input.input.claim.checkpointId,
      input.checkpointRevision, input.pendingRef, input.pendingJson,
      input.identity.ledgerId, input.identity.programId, input.baseManifestRevision,
      input.baseManifestHash, input.contentionKind, input.baseProjectHeadJson,
      input.winner, input.claimPath, input.winner, input.activationKey,
      new Date().toISOString(),
    );
  }

  private relinquishStateClaim(input: CommitInput): void {
    const claim = this.db.query(`
      UPDATE btcc_state_claims SET status = 'relinquished'
      WHERE claim_id = ? AND turn_id = ? AND turn_revision = ?
        AND checkpoint_revision = ? AND execution_fence = ? AND status = 'active'
    `).run(
      input.claim.claimId, input.claim.turnId, input.claim.turnRevision,
      input.claim.checkpointRevision, input.claim.executionFence,
    );
    if (claim.changes !== 1) throw new Error("Ledger contention lost its exact State claim");
    const checkpoint = this.db.query(`
      UPDATE btcc_checkpoints SET active_claim_id = NULL
      WHERE checkpoint_id = ? AND checkpoint_revision = ? AND active_claim_id = ?
    `).run(input.claim.checkpointId, input.claim.checkpointRevision, input.claim.claimId);
    if (checkpoint.changes !== 1) {
      throw new Error("Ledger contention lost its exact active checkpoint claim");
    }
  }

  private status(contentionId: string): string | undefined {
    return this.db.query<{ status: string }, [string]>(`
      SELECT status FROM btcc_ledger_contentions WHERE contention_id = ?
    `).get(contentionId)?.status;
  }

  private latestPendingSubmission(checkpointId: string) {
    return this.db.query<{
      checkpoint_revision: number;
      pending_submission_ref: string | null;
      pending_submission_json: string | null;
    }, [string]>(`
      SELECT checkpoint_revision, pending_submission_ref, pending_submission_json
      FROM btcc_phase_checkpoint_revisions WHERE checkpoint_id = ?
      ORDER BY checkpoint_revision DESC LIMIT 1
    `).get(checkpointId);
  }

  private ownedContentions(): ContentionRow[] {
    return this.db.query<ContentionRow, []>(`
      SELECT contention_id, checkpoint_id, ledger_id, program_id,
        checkpoint_revision, contention_kind, base_project_head_json,
        winning_publication_id, claim_path
      FROM btcc_ledger_contentions WHERE status = 'owned'
      ORDER BY activation_key
    `).all();
  }

  private claimReleased(row: ContentionRow): boolean {
    if (row.contention_kind === "publication_claim") {
      return this.project!.publications.observePublicationState(
        row.winning_publication_id,
      ) === "released";
    }
    if (row.contention_kind === "mutation_claim") {
      return this.project!.publications.observeMutationClaimState(
        row.claim_path,
        row.winning_publication_id,
      ) === "released";
    }
    return false;
  }

  private projectBinding(programId: string): string | undefined {
    return this.db.query<{ project_ref: string }, [string]>(`
      SELECT project_ref FROM btcc_project_program_projections WHERE program_id = ?
    `).get(programId)?.project_ref;
  }

  private persistProjectBinding(commit: WorkLedgerCommit): void {
    if (commit.mutation.kind !== "bind_program") return;
    const scope = commit.mutation.product.authority.ledgerScope;
    if (scope.kind !== "project") return;
    const identity = ledgerIdentityOf(commit);
    this.db.query(`
      INSERT INTO btcc_project_program_projections (
        program_id, project_ref, ledger_id, manifest_revision
      ) VALUES (?, ?, ?, ?) ON CONFLICT(program_id) DO NOTHING
    `).run(identity.programId, scope.projectRef, identity.ledgerId, baseRevisionOf(commit));
  }
}

function ledgerIdentityOf(commit: WorkLedgerCommit) {
  const mutation = commit.mutation;
  if (mutation.kind === "bind_program") {
    return {
      ledgerId: mutation.product.authority.managedBinding.ledgerId,
      programId: mutation.product.authority.managedBinding.programId,
    };
  }
  if (mutation.kind === "install_reviewed_plan") {
    return { ledgerId: mutation.product.candidate.ledgerId, programId: mutation.product.candidate.programId };
  }
  return { ledgerId: mutation.cursor.ledgerId, programId: mutation.cursor.programId };
}

function baseRevisionOf(commit: WorkLedgerCommit): number {
  const mutation = commit.mutation;
  if (mutation.kind === "bind_program") {
    return mutation.product.authority.managedBinding.expectedManifestRevision;
  }
  if (mutation.kind === "install_reviewed_plan") return mutation.product.candidate.observedManifestRevision;
  return mutation.cursor.expectedManifestRevision;
}
