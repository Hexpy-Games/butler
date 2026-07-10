import { createHash } from "crypto";
import { join } from "path";
import { readJsonFile, withDurableFileLock, writeJsonFileAtomic, type DurableLockLease } from "../persistence/atomic-json-store.ts";
import type { WorkStreamRecord } from "./work-stream.ts";

const AUTHORITY = Symbol("work-stream-mutation-authority");
const TERMINAL_STATES = new Set(["complete", "failed", "cancelled"]);

export type WorkStreamMutationOperation =
  | "claim"
  | "supply_user_action"
  | "renew_claim"
  | "release_claim"
  | "contract_cancel"
  | "wait_user"
  | "plan_amendment"
  | "plan_recovery"
  | "reporting_completion"
  | "reporting_recovery"
  | "legacy_todo_update"
  | "legacy_transition"
  | "legacy_link"
  | "legacy_outcome"
  | "legacy_cancel";

export interface WorkStreamMutationContext {
  readonly workstreamId: string;
  readonly operation: WorkStreamMutationOperation;
  readonly ownerId: string;
  readonly authorization?: WorkStreamContractAuthorization;
  readonly lease: DurableLockLease;
  readonly [AUTHORITY]: true;
}

export interface WorkStreamContractAuthorization {
  contractId: string;
  releasedContractId?: string;
  blockerId?: string;
}

export function withWorkStreamMutationAuthority<T>(input: {
  butlerData: string;
  workstreamId: string;
  operation: WorkStreamMutationOperation;
  ownerId: string;
  authorization?: WorkStreamContractAuthorization;
  now?: Date;
  busyTimeoutMs?: number;
  action: (context: WorkStreamMutationContext) => T;
}): T | null {
  return withDurableFileLock({
    lockPath: workStreamMutationLockPath(input.butlerData, input.workstreamId),
    lockRoot: input.butlerData,
    ownerId: input.ownerId,
    now: input.now,
    busyTimeoutMs: input.busyTimeoutMs,
    action: (lease) => input.action({
      workstreamId: input.workstreamId,
      operation: input.operation,
      ownerId: input.ownerId,
      authorization: input.authorization,
      lease,
      [AUTHORITY]: true,
    }),
  });
}

export function commitWorkStreamMutation(input: {
  butlerData: string;
  context: WorkStreamMutationContext;
  record: WorkStreamRecord;
  expectedGeneration: number | null;
}): WorkStreamRecord {
  assertAuthority(input.context, input.record.id);
  assertCurrentFence(input.context);
  const path = workStreamRecordPath(input.butlerData, input.record.id);
  const current = readJsonFile<WorkStreamRecord>(path);
  const currentGeneration = current?.record_generation ?? (current ? 1 : null);
  if (currentGeneration !== input.expectedGeneration) {
    throw new Error("workstream_mutation_generation_conflict");
  }
  assertTerminalImmutable(current, input.record);
  assertClaimTupleMutation(current, input.record, input.context);
  if (
    input.record.state === "cancelled" &&
    current?.active_contract_id &&
    input.context.operation !== "contract_cancel"
  ) {
    throw new Error("workstream_claimed_cancel_requires_receipt");
  }
  const requiredGeneration = (currentGeneration ?? 0) + 1;
  if (input.record.record_generation !== requiredGeneration) {
    throw new Error("workstream_mutation_generation_invalid");
  }
  writeJsonFileAtomic(path, input.record);
  return input.record;
}

export function authorizeWorkStreamMutation(
  context: WorkStreamMutationContext,
  authorization: WorkStreamContractAuthorization,
): WorkStreamMutationContext {
  if (context[AUTHORITY] !== true) throw new Error("workstream_mutation_authority_invalid");
  return { ...context, authorization, [AUTHORITY]: true };
}

export function workStreamRecordFingerprint(record: WorkStreamRecord): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

export function workStreamMutationLockPath(butlerData: string, workstreamId: string): string {
  return join(butlerData, "work-streams", `${safeId(workstreamId)}.mutation.lock`);
}

function workStreamRecordPath(butlerData: string, workstreamId: string): string {
  return join(butlerData, "work-streams", `${safeId(workstreamId)}.json`);
}

function assertAuthority(context: WorkStreamMutationContext, recordId: string): void {
  if (context[AUTHORITY] !== true || context.workstreamId !== recordId) {
    throw new Error("workstream_mutation_authority_invalid");
  }
}

function assertCurrentFence(context: WorkStreamMutationContext): void {
  if (!context.lease.isOwned()) throw new Error("workstream_mutation_fence_lost");
}

function assertClaimTupleMutation(
  current: WorkStreamRecord | null,
  next: WorkStreamRecord,
  context: WorkStreamMutationContext,
): void {
  if (!current || claimTupleFingerprint(current) === claimTupleFingerprint(next)) return;
  const authorization = context.authorization;
  if (!authorization) throw new Error("workstream_claim_tuple_authorization_required");
  const originalPreserved = current.original_claim_receipt_id === next.original_claim_receipt_id;
  switch (context.operation) {
    case "claim":
      if (
        next.active_contract_id === authorization.contractId && !next.active_blocker_id &&
        next.original_claim_receipt_id === next.active_claim_receipt_id
      ) return;
      break;
    case "renew_claim":
      if (current.active_contract_id === authorization.contractId && next.active_contract_id === authorization.contractId && originalPreserved) return;
      break;
    case "wait_user":
      if (
        current.active_contract_id === authorization.contractId && next.active_contract_id === authorization.contractId &&
        next.active_blocker_id === authorization.blockerId && originalPreserved
      ) return;
      break;
    case "supply_user_action":
      if (
        current.active_blocker_id === authorization.blockerId && next.active_contract_id === authorization.contractId &&
        !next.active_blocker_id && next.original_claim_receipt_id === next.active_claim_receipt_id
      ) return;
      break;
    case "contract_cancel":
      if (
        current.active_contract_id === authorization.releasedContractId && !next.active_contract_id &&
        !next.active_blocker_id && originalPreserved
      ) return;
      break;
    case "release_claim":
      if (
        current.active_contract_id === authorization.releasedContractId &&
        !next.active_contract_id && !next.active_blocker_id && originalPreserved
      ) return;
      break;
    default:
      break;
  }
  throw new Error("workstream_claim_tuple_authorization_mismatch");
}

function claimTupleFingerprint(record: WorkStreamRecord): string {
  return JSON.stringify({
    active_contract_id: record.active_contract_id ?? null,
    claim_generation: record.claim_generation ?? null,
    claim_lease_expires_at: record.claim_lease_expires_at ?? null,
    active_claim_receipt_id: record.active_claim_receipt_id ?? null,
    original_claim_receipt_id: record.original_claim_receipt_id ?? null,
    active_blocker_id: record.active_blocker_id ?? null,
    active_blocker_evidence_id: record.active_blocker_evidence_id ?? null,
  });
}

function assertTerminalImmutable(current: WorkStreamRecord | null, next: WorkStreamRecord): void {
  if (!current || !TERMINAL_STATES.has(current.state)) return;
  if (current.state !== next.state) throw new Error("workstream_terminal_state_immutable");
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) throw new Error("workstream_mutation_unsafe_id");
  return value;
}
