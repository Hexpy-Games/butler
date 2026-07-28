import type { Database } from "bun:sqlite";
import type {
  ActualModelIdentity,
  BtccRuntimeDependencies,
  OperationRequest,
  OperationResult,
  PhaseContinuity,
  PhaseEnvelope,
  PhaseRunBinding,
  ProviderCorrection,
} from "../../../btcc/gateway-api.ts";
import { stableJson } from "./identity.ts";
import {
  contentRefId,
  decodePendingOperation,
  decodePendingSubmission,
  decodeProviderCorrection,
  optionalJson,
  revisionRef,
} from "./phase-conversation/checkpoint-codec.ts";
import { PhaseOperationResultLinks } from
  "./phase-conversation/operation-result-links.ts";
import { PhaseModelRoundLog } from
  "./phase-conversation/model-round-log.ts";

type PhaseConversationStore = BtccRuntimeDependencies["phaseConversations"];
type CheckpointHead = {
  checkpoint_revision: number;
  accepted_product_json: string | null;
  actual_identity_json: string | null;
  active_claim_id: string | null;
  is_active: number;
};

export class SqlitePhaseConversationStore implements PhaseConversationStore {
  private readonly operationResults: PhaseOperationResultLinks;
  private readonly modelRounds: PhaseModelRoundLog;

  constructor(private readonly db: Database) {
    this.operationResults = new PhaseOperationResultLinks(db);
    this.modelRounds = new PhaseModelRoundLog(db);
  }

  async restore<Product>(binding: PhaseRunBinding) {
    const head = this.loadHead(binding, false);
    const revision = this.db.query<{
      pending_operation_json: string | null;
      pending_submission_json: string | null;
      provider_correction_json: string | null;
    }, [string, number]>(`
      SELECT pending_operation_json, pending_submission_json,
        provider_correction_json
      FROM btcc_phase_checkpoint_revisions
      WHERE checkpoint_id = ? AND checkpoint_revision = ?
    `).get(binding.checkpointId, head.checkpoint_revision);
    const currentBinding = { ...binding, checkpointRevision: head.checkpoint_revision };
    const latestOperation = this.loadLatestOperation(currentBinding);
    return {
      binding: currentBinding,
      acceptedProduct: head.accepted_product_json
        ? JSON.parse(head.accepted_product_json) as Product
        : null,
      ...(head.actual_identity_json
        ? { acceptedActualIdentity: JSON.parse(head.actual_identity_json) as ActualModelIdentity }
        : {}),
      ...(revision?.provider_correction_json
        ? { providerCorrection: decodeProviderCorrection(revision.provider_correction_json) }
        : {}),
      operationResults: this.operationResults.load(currentBinding),
      latestOperationResultCount: this.operationResults.loadLatestBatchSize(currentBinding),
      ...(latestOperation?.phaseContinuity
        ? { phaseContinuity: latestOperation.phaseContinuity }
        : {}),
      ...(revision?.pending_operation_json
        ? { pendingOperationRound: decodePendingOperation(revision.pending_operation_json) }
        : {}),
      ...(revision?.pending_submission_json
        ? { pendingSubmissionRound: decodePendingSubmission(revision.pending_submission_json) }
        : {}),
    };
  }

  async appendOperationRound(input: {
    binding: PhaseRunBinding;
    envelope: PhaseEnvelope;
    requests: OperationRequest[];
    phaseContinuity?: PhaseContinuity;
    actualIdentity: ActualModelIdentity;
  }): Promise<PhaseRunBinding> {
    if (input.requests.length === 0) throw new Error("BTCC operation round cannot be empty");
    const carrier = {
      kind: "operation_requests" as const,
      requests: input.requests,
      ...(input.phaseContinuity ? { phaseContinuity: input.phaseContinuity } : {}),
      actualIdentity: input.actualIdentity,
    };
    return this.db.transaction(() => {
      this.loadHead(input.binding, true);
      const next = this.appendRevision({
        binding: input.binding,
        status: "pending_operations",
        envelope: input.envelope,
        providerRound: carrier,
        pendingOperation: carrier,
      });
      this.modelRounds.append(input.binding, next.checkpointRevision, carrier);
      return next;
    })();
  }

  async appendOperationResults(input: {
    binding: PhaseRunBinding;
    results: Array<{ request: OperationRequest; result: OperationResult }>;
    pendingSubmissionRound?: Awaited<
      ReturnType<PhaseConversationStore["restore"]>
    >["pendingSubmissionRound"];
  }): Promise<PhaseRunBinding> {
    if (input.results.length === 0) throw new Error("BTCC operation result append cannot be empty");
    return this.db.transaction(() => {
      this.loadHead(input.binding, true);
      const results = input.results.map((item) => ({
        request: item.request,
        result: this.operationResults.insert(input.binding, item),
      }));
      return this.appendRevision({
        binding: input.binding,
        status: "operations_applied",
        operationResultRefs: results.map(({ result }) => result.resultRef),
        ...(input.pendingSubmissionRound
          ? { pendingSubmission: input.pendingSubmissionRound }
          : {}),
      });
    })();
  }

  async appendPhaseSubmission(input: {
    binding: PhaseRunBinding;
    envelope: PhaseEnvelope;
    submission: unknown;
    publicActivity?: PhaseContinuity["publicActivity"];
    actualIdentity: ActualModelIdentity;
  }): Promise<PhaseRunBinding> {
    const providerRound = {
      kind: "phase_submission" as const,
      submission: input.submission,
      ...(input.publicActivity ? { publicActivity: input.publicActivity } : {}),
      actualIdentity: input.actualIdentity,
    };
    return this.db.transaction(() => {
      this.loadHead(input.binding, true);
      const next = this.appendRevision({
        binding: input.binding,
        status: "pending_boundary",
        envelope: input.envelope,
        providerRound,
        pendingSubmission: providerRound,
      });
      this.modelRounds.append(input.binding, next.checkpointRevision, providerRound);
      return next;
    })();
  }

  async appendProviderProductRejection(input: {
    binding: PhaseRunBinding;
    envelope: PhaseEnvelope;
    submission: unknown;
    publicActivity?: PhaseContinuity["publicActivity"];
    actualIdentity: ActualModelIdentity;
    correction: ProviderCorrection;
  }): Promise<PhaseRunBinding> {
    const providerRound = {
      kind: "phase_submission" as const,
      submission: input.submission,
      ...(input.publicActivity ? { publicActivity: input.publicActivity } : {}),
      actualIdentity: input.actualIdentity,
    };
    return this.db.transaction(() => {
      this.loadHead(input.binding, true);
      const next = this.appendRevision({
        binding: input.binding,
        status: "provider_product_rejected",
        envelope: input.envelope,
        providerRound,
        providerCorrection: input.correction,
      });
      this.modelRounds.append(input.binding, next.checkpointRevision, providerRound);
      return next;
    })();
  }

  async acceptPhaseProduct<Product>(input: {
    binding: PhaseRunBinding;
    product: Product;
  }): Promise<PhaseRunBinding> {
    return this.db.transaction(() => {
      const head = this.loadHead(input.binding, true);
      const pending = this.loadPendingSubmission(input.binding);
      const productJson = stableJson(input.product);
      const identityJson = stableJson(pending.actualIdentity);
      if (head.accepted_product_json) {
        if (head.accepted_product_json !== productJson || head.actual_identity_json !== identityJson) {
          throw new Error("BTCC checkpoint product identity conflict");
        }
        return input.binding;
      }
      return this.appendRevision({
        binding: input.binding,
        status: "accepted_boundary",
        productBundle: input.product,
        acceptedProductJson: productJson,
        actualIdentityJson: identityJson,
      });
    })();
  }

  private appendRevision(input: {
    binding: PhaseRunBinding;
    status: "pending_operations" | "operations_applied" | "pending_boundary" |
      "accepted_boundary" | "provider_product_rejected";
    envelope?: PhaseEnvelope;
    providerRound?: unknown;
    providerCorrection?: ProviderCorrection;
    pendingOperation?: unknown;
    pendingSubmission?: unknown;
    productBundle?: unknown;
    operationResultRefs?: Array<{ id: string; sha256: string }>;
    acceptedProductJson?: string;
    actualIdentityJson?: string;
  }): PhaseRunBinding {
    const nextRevision = input.binding.checkpointRevision + 1;
    const envelopeJson = optionalJson(input.envelope);
    const providerRoundJson = optionalJson(input.providerRound);
    const providerCorrectionJson = optionalJson(input.providerCorrection);
    const pendingSubmissionJson = optionalJson(input.pendingSubmission);
    const productBundleJson = optionalJson(input.productBundle);
    this.db.query(`
      INSERT INTO btcc_phase_checkpoint_revisions (
        checkpoint_id, checkpoint_revision, previous_revision_ref,
        phase_envelope_ref, phase_envelope_json,
        provider_round_ref, provider_round_json,
        provider_correction_json,
        pending_operation_json, pending_submission_ref, pending_submission_json,
        product_bundle_ref, product_bundle_json, operation_result_refs_json,
        state_claim_id, execution_fence, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.binding.checkpointId,
      nextRevision,
      revisionRef(input.binding.checkpointId, input.binding.checkpointRevision),
      contentRefId("phase-envelope", envelopeJson),
      envelopeJson,
      contentRefId("provider-round", providerRoundJson),
      providerRoundJson,
      providerCorrectionJson,
      optionalJson(input.pendingOperation),
      contentRefId("pending-boundary-submission", pendingSubmissionJson),
      pendingSubmissionJson,
      contentRefId("phase-product-bundle", productBundleJson),
      productBundleJson,
      optionalJson(input.operationResultRefs),
      input.binding.claimId,
      input.binding.executionFence,
      input.status,
    );
    const checkpoint = input.acceptedProductJson
      ? this.db.query(`
          UPDATE btcc_checkpoints
          SET checkpoint_revision = ?, accepted_product_json = ?, actual_identity_json = ?
          WHERE checkpoint_id = ? AND checkpoint_revision = ?
            AND active_claim_id = ? AND is_active = 1
        `).run(
          nextRevision,
          input.acceptedProductJson,
          input.actualIdentityJson ?? null,
          input.binding.checkpointId,
          input.binding.checkpointRevision,
          input.binding.claimId,
        )
      : this.db.query(`
          UPDATE btcc_checkpoints SET checkpoint_revision = ?
          WHERE checkpoint_id = ? AND checkpoint_revision = ?
            AND active_claim_id = ? AND is_active = 1
        `).run(
          nextRevision,
          input.binding.checkpointId,
          input.binding.checkpointRevision,
          input.binding.claimId,
        );
    const claim = this.db.query(`
      UPDATE btcc_state_claims SET checkpoint_revision = ?
      WHERE claim_id = ? AND checkpoint_revision = ? AND status = 'active'
    `).run(nextRevision, input.binding.claimId, input.binding.checkpointRevision);
    if (checkpoint.changes !== 1 || claim.changes !== 1) {
      throw new Error("BTCC phase checkpoint append lost its exact CAS");
    }
    return { ...input.binding, checkpointRevision: nextRevision };
  }

  private loadPendingSubmission(binding: PhaseRunBinding) {
    const row = this.db.query<{ pending_submission_json: string | null }, [string, number]>(`
      SELECT pending_submission_json FROM btcc_phase_checkpoint_revisions
      WHERE checkpoint_id = ? AND checkpoint_revision = ?
    `).get(binding.checkpointId, binding.checkpointRevision);
    if (!row?.pending_submission_json) {
      throw new Error("BTCC accepted phase product has no pending provider submission");
    }
    return decodePendingSubmission(row.pending_submission_json);
  }

  private loadLatestOperation(binding: PhaseRunBinding) {
    const row = this.db.query<{ pending_operation_json: string }, [string, number]>(`
      SELECT pending_operation_json
      FROM btcc_phase_checkpoint_revisions
      WHERE checkpoint_id = ? AND checkpoint_revision <= ?
        AND pending_operation_json IS NOT NULL
      ORDER BY checkpoint_revision DESC LIMIT 1
    `).get(binding.checkpointId, binding.checkpointRevision);
    return row ? decodePendingOperation(row.pending_operation_json) : undefined;
  }

  private loadHead(binding: PhaseRunBinding, requireExactRevision: boolean): CheckpointHead {
    const row = this.db.query<CheckpointHead, [string]>(`
      SELECT checkpoint_revision, accepted_product_json, actual_identity_json,
        active_claim_id, is_active FROM btcc_checkpoints WHERE checkpoint_id = ?
    `).get(binding.checkpointId);
    const claim = this.db.query<{
      status: string;
      checkpoint_revision: number;
      execution_fence: number;
    }, [string]>(`
      SELECT status, checkpoint_revision, execution_fence
      FROM btcc_state_claims WHERE claim_id = ?
    `).get(binding.claimId);
    if (
      !row || row.is_active !== 1 || row.active_claim_id !== binding.claimId ||
      claim?.status !== "active" || claim.checkpoint_revision !== row.checkpoint_revision ||
      claim.execution_fence !== binding.executionFence ||
      (requireExactRevision
        ? row.checkpoint_revision !== binding.checkpointRevision
        : row.checkpoint_revision < binding.checkpointRevision)
    ) {
      throw new Error("BTCC phase checkpoint is not owned by the exact active claim");
    }
    return row;
  }
}
