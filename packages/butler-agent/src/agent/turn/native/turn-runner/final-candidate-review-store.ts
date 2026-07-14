import { createHash } from "crypto";
import { join } from "path";
import {
  readJsonFile,
  withDurableFileLock,
  writeJsonFileAtomic,
} from "../../../persistence/atomic-json-store.ts";
import type {
  PublicWebEvidenceAttempt,
  PublicWebEvidenceContext,
} from "../../../output/evidence/public-web-evidence-store.ts";
import type { PublicWebEvidenceItem } from "../../../output/evidence/public-web-evidence.ts";

export const FINAL_CANDIDATE_REVIEW_STORE_SCHEMA =
  "butler.final-candidate-review-store.v1" as const;

export type FinalCandidateReviewState =
  | "pending_review"
  | "reviewing"
  | "review_gap_pending"
  | "accepted"
  | "delivery_pending"
  | "delivered"
  | "superseded"
  | "cancelled"
  | "recoverable";

export interface FinalCandidateReviewJob {
  job_id: string;
  state: "pending" | "leased" | "completed" | "cancelled" | "recoverable";
  next_node_id: string;
  lease_generation: number;
  completed_node_receipt_ids: string[];
}

export interface FinalCandidateCheckpoint {
  candidate_id: string;
  revision: number;
  turn_id: string;
  session_id: string;
  contract_id: string | null;
  user_message_id: string;
  user_message_sha256: string;
  user_message_text: string;
  candidate_sha256: string;
  candidate_text: string;
  candidate_utf8_bytes: number;
  evidence_revision: string;
  evidence_items: PublicWebEvidenceItem[];
  evidence_attempts: PublicWebEvidenceAttempt[];
  provider_adapter_id: string;
  effective_model: string;
  state: FinalCandidateReviewState;
  review_job: FinalCandidateReviewJob;
  reviewed_text?: string;
  evidence_refs: string[];
  gap_fingerprint?: string;
  delivery_action_id?: string;
  created_at: string;
  updated_at: string;
}

interface FinalCandidateReviewAggregate {
  schema_version: typeof FINAL_CANDIDATE_REVIEW_STORE_SCHEMA;
  turn_id: string;
  generation: number;
  current_candidate_id: string;
  candidates: FinalCandidateCheckpoint[];
  updated_at: string;
}

export interface FinalCandidateProposal {
  butlerData: string;
  turnId: string;
  sessionId: string;
  contractId?: string | null;
  userMessageId: string;
  userText: string;
  candidateText: string;
  evidence: PublicWebEvidenceContext;
  reviewProgressRevision?: string;
  providerAdapterId: string;
  effectiveModel: string;
}

export function commitFinalCandidateProposal(
  input: FinalCandidateProposal,
): FinalCandidateCheckpoint {
  const turnId = safeRef(input.turnId);
  const path = aggregatePath(input.butlerData, turnId);
  const committed = withDurableFileLock({
    lockPath: `${path}.lock`,
    lockRoot: input.butlerData,
    ownerId: `final-candidate-review:${turnId}`,
    action: () => {
      const existing = readAggregate(path, turnId);
      const candidateHash = sha256(input.candidateText);
      const evidenceRevision = sha256(JSON.stringify({
        public_evidence_revision: evidenceRevisionFor(input.evidence),
        review_progress_revision: input.reviewProgressRevision ?? "none",
      }));
      const current = existing?.candidates.find(
        (candidate) => candidate.candidate_id === existing.current_candidate_id,
      );
      const sameProposal =
        current?.candidate_sha256 === candidateHash &&
        current.evidence_revision === evidenceRevision &&
        current.user_message_sha256 === sha256(input.userText);
      if (sameProposal) {
        if (current.provider_adapter_id !== safeRef(input.providerAdapterId) ||
          current.effective_model !== safeRef(input.effectiveModel)) {
          throw new Error("final_candidate_effective_model_identity_conflict");
        }
        return { aggregate: existing!, candidate: current };
      }

      const now = new Date().toISOString();
      const revision = Math.max(0, ...(existing?.candidates.map((item) => item.revision) ?? [])) + 1;
      const candidateId = `candidate-${sha256(`${turnId}\n${revision}\n${candidateHash}\n${evidenceRevision}`).slice(0, 24)}`;
      const candidates = (existing?.candidates ?? []).map((candidate) =>
        candidate.candidate_id === existing?.current_candidate_id &&
          !isTerminalCandidateState(candidate.state)
          ? { ...candidate, state: "superseded" as const, updated_at: now }
          : candidate,
      );
      const candidate: FinalCandidateCheckpoint = {
        candidate_id: candidateId,
        revision,
        turn_id: turnId,
        session_id: safeRef(input.sessionId),
        contract_id: input.contractId ? safeRef(input.contractId) : null,
        user_message_id: safeRef(input.userMessageId),
        user_message_sha256: sha256(input.userText),
        user_message_text: input.userText,
        candidate_sha256: candidateHash,
        candidate_text: input.candidateText,
        candidate_utf8_bytes: Buffer.byteLength(input.candidateText, "utf8"),
        evidence_revision: evidenceRevision,
        evidence_items: structuredClone(input.evidence.items),
        evidence_attempts: structuredClone(input.evidence.attempts),
        provider_adapter_id: safeRef(input.providerAdapterId),
        effective_model: safeRef(input.effectiveModel),
        state: "pending_review",
        review_job: {
          job_id: `review-job-${sha256(candidateId).slice(0, 24)}`,
          state: "pending",
          next_node_id: "grounding_review",
          lease_generation: 0,
          completed_node_receipt_ids: [],
        },
        evidence_refs: [],
        created_at: now,
        updated_at: now,
      };
      const aggregate: FinalCandidateReviewAggregate = {
        schema_version: FINAL_CANDIDATE_REVIEW_STORE_SCHEMA,
        turn_id: turnId,
        generation: (existing?.generation ?? 0) + 1,
        current_candidate_id: candidateId,
        candidates: [...candidates, candidate],
        updated_at: now,
      };
      writeJsonFileAtomic(path, aggregate);
      return { aggregate, candidate };
    },
  });
  if (!committed) throw new Error("final_candidate_review_owner_commit_failed");
  return committed.candidate;
}

export function readCurrentFinalCandidate(input: {
  butlerData: string;
  turnId: string;
}): FinalCandidateCheckpoint | null {
  const turnId = safeRef(input.turnId);
  const aggregate = readAggregate(aggregatePath(input.butlerData, turnId), turnId);
  return aggregate?.candidates.find(
    (candidate) => candidate.candidate_id === aggregate.current_candidate_id,
  ) ?? null;
}

export function cancelCurrentFinalCandidate(input: {
  butlerData: string;
  turnId: string;
}): FinalCandidateCheckpoint | null {
  const current = readCurrentFinalCandidate(input);
  if (!current || current.state === "delivered" || current.state === "cancelled") return current;
  return updateFinalCandidateReview({
    ...input,
    candidateId: current.candidate_id,
    state: "cancelled",
  });
}

export function updateFinalCandidateReview(input: {
  butlerData: string;
  turnId: string;
  candidateId: string;
  state: FinalCandidateReviewState;
  reviewedText?: string;
  evidenceRefs?: string[];
  gapFingerprint?: string;
  completedReceiptId?: string;
  deliveryActionId?: string;
}): FinalCandidateCheckpoint {
  const turnId = safeRef(input.turnId);
  const path = aggregatePath(input.butlerData, turnId);
  const committed = withDurableFileLock({
    lockPath: `${path}.lock`,
    lockRoot: input.butlerData,
    ownerId: `final-candidate-review:${turnId}`,
    action: () => {
      const existing = readAggregate(path, turnId);
      if (!existing) throw new Error("final_candidate_review_checkpoint_missing");
      const now = new Date().toISOString();
      let updated: FinalCandidateCheckpoint | null = null;
      const candidates = existing.candidates.map((candidate) => {
        if (candidate.candidate_id !== input.candidateId) return candidate;
        const jobState: FinalCandidateReviewJob["state"] = input.state === "reviewing"
          ? "leased"
          : input.state === "delivered"
          ? "completed"
          : input.state === "cancelled" || input.state === "superseded"
          ? "cancelled"
          : input.state === "recoverable"
          ? "recoverable"
          : "pending";
        updated = {
          ...candidate,
          state: input.state,
          ...(input.reviewedText === undefined ? {} : { reviewed_text: input.reviewedText }),
          ...(input.evidenceRefs === undefined ? {} : { evidence_refs: [...new Set(input.evidenceRefs)] }),
          ...(input.gapFingerprint === undefined ? {} : { gap_fingerprint: input.gapFingerprint }),
          ...(input.deliveryActionId === undefined
            ? {}
            : { delivery_action_id: safeRef(input.deliveryActionId) }),
          review_job: {
            ...candidate.review_job,
            state: jobState,
            next_node_id: input.state === "accepted" || input.state === "delivery_pending" ||
                input.state === "delivered"
              ? "delivery"
              : "grounding_review",
            lease_generation: input.state === "reviewing"
              ? candidate.review_job.lease_generation + 1
              : candidate.review_job.lease_generation,
            completed_node_receipt_ids: input.completedReceiptId
              ? [...new Set([...candidate.review_job.completed_node_receipt_ids, input.completedReceiptId])]
              : candidate.review_job.completed_node_receipt_ids,
          },
          updated_at: now,
        };
        return updated;
      });
      if (!updated) throw new Error("final_candidate_review_candidate_missing");
      writeJsonFileAtomic(path, {
        ...existing,
        generation: existing.generation + 1,
        candidates,
        updated_at: now,
      });
      return updated;
    },
  });
  if (!committed) throw new Error("final_candidate_review_owner_commit_failed");
  return committed;
}

export function markFinalCandidateDelivered(input: {
  butlerData: string;
  turnId: string;
  deliveryActionId: string;
}): FinalCandidateCheckpoint | null {
  const current = readCurrentFinalCandidate(input);
  if (!current) return null;
  if (current.state === "delivered") {
    if (current.delivery_action_id !== safeRef(input.deliveryActionId)) {
      throw new Error("final_candidate_delivery_identity_conflict");
    }
    return current;
  }
  if (current.state !== "delivery_pending") {
    throw new Error("final_candidate_delivery_state_invalid");
  }
  return updateFinalCandidateReview({
    ...input,
    candidateId: current.candidate_id,
    state: "delivered",
    deliveryActionId: input.deliveryActionId,
    completedReceiptId: `delivery-receipt-${current.candidate_id}`,
  });
}

export function evidenceRevisionFor(context: PublicWebEvidenceContext): string {
  return sha256(JSON.stringify({
    items: context.items,
    attempts: context.attempts,
  }));
}

function readAggregate(path: string, turnId: string): FinalCandidateReviewAggregate | null {
  const value = readJsonFile<FinalCandidateReviewAggregate>(path);
  if (
    value?.schema_version !== FINAL_CANDIDATE_REVIEW_STORE_SCHEMA ||
    value.turn_id !== turnId || !Array.isArray(value.candidates)
  ) return null;
  return value;
}

function aggregatePath(butlerData: string, turnId: string): string {
  return join(butlerData, "state", "final-candidate-review", `${sha256(turnId)}.json`);
}

function isTerminalCandidateState(state: FinalCandidateReviewState): boolean {
  return new Set<FinalCandidateReviewState>([
    "delivered", "superseded", "cancelled", "recoverable",
  ]).has(state);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeRef(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim().slice(0, 240) || "unknown";
}
