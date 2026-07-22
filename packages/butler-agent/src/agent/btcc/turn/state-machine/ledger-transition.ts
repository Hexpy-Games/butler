import {
  ledgerManifestContentHash,
  ledgerMutationId,
  type WorkLedgerMutation,
} from "../../work-ledger/index.ts";
import type { TurnRecord } from "../contracts.ts";
import { requireManagedPlanningAuthority } from "../managed-turn-state.ts";

export function ledgerCursor(turn: TurnRecord) {
  const program = requireManagedPlanningAuthority(turn);
  return {
    ledgerId: program.ledgerId,
    programId: program.programId,
    expectedManifestRevision: program.manifestRevision,
  };
}

export function ledgerCommit<M extends WorkLedgerMutation>(
  turn: TurnRecord,
  mutation: M,
) {
  const expectedTurnRevision = turn.revision + 1;
  const identity = ledgerIdentity(mutation);
  const previous = turn.managed?.program ?? null;
  const baseManifestHash = previous
    ? ledgerManifestContentHash(previous, identity)
    : continuationBaseManifestHash(mutation)
      ?? ledgerManifestContentHash(null, identity);
  return {
    mutationId: ledgerMutationId({
      commit: { turnId: turn.turnId, expectedTurnRevision, mutation },
      baseManifestHash,
    }),
    turnId: turn.turnId,
    expectedTurnRevision,
    mutation,
  } as const;
}

function continuationBaseManifestHash(mutation: WorkLedgerMutation): string | undefined {
  if (mutation.kind !== "bind_program") return undefined;
  const binding = mutation.product.authority.managedBinding.continuationBinding;
  return binding.kind === "deferred_goal" ? binding.baseManifestHash : undefined;
}

function ledgerIdentity(mutation: WorkLedgerMutation) {
  if (mutation.kind === "bind_program") {
    return {
      ledgerId: mutation.product.authority.managedBinding.ledgerId,
      programId: mutation.product.authority.managedBinding.programId,
    };
  }
  if (mutation.kind === "install_reviewed_plan") {
    return {
      ledgerId: mutation.product.candidate.ledgerId,
      programId: mutation.product.candidate.programId,
    };
  }
  return { ledgerId: mutation.cursor.ledgerId, programId: mutation.cursor.programId };
}
