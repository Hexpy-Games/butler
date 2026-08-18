import type {
  AppTransportProjectionStoreOptions,
} from "./transport-projection-contract.ts";
import { safeOptionalShortToken } from "../core/projection-safe-values.ts";

/**
 * Runs a claimed App outbound mutation only while its durable queue claim is
 * still current.  The lookup is advisory; the compare-and-set fence is kept
 * inside the same SQLite transaction as the mutation so a reclaimed claim
 * cannot leave a stale receipt, progress row, or cancellation outbox entry.
 */
export function projectClaimedOutbound(
  options: AppTransportProjectionStoreOptions,
  input: {
    chatId: string;
    turnId: string;
    metadata: Record<string, unknown>;
    claimFenceAlreadyHeld?: boolean;
  },
  project: () => boolean,
): boolean {
  if (input.claimFenceAlreadyHeld) return project();
  const claimId = safeOptionalShortToken(input.metadata.appQueueClaimId);
  const status = options.queuedTurnClaimStatus(
    input.chatId,
    input.turnId,
    claimId,
  );
  if (status === "unlinked") return project();
  if (!claimId) return false;
  return options.db.transaction(() => {
    if (!options.fenceQueuedTurnClaim({
      chatId: input.chatId,
      turnId: input.turnId,
      claimId,
    })) return false;
    return project();
  })();
}
