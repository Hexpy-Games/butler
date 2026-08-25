import { createAppCancellationEnvelope } from "../../../gateways/core/app-transport.ts";
import type { NativeInboundQueue } from "../../../gateways/core/inbound-queue.ts";
import { digest, stableJson } from "../identity/index.ts";
import type {
  SessionRelation,
  SubsessionDelegationDependencies,
  SubsessionDelegationService,
} from "./contracts.ts";
import { activeParentDelegations } from "./active-parent-delegation.ts";

type ControlService = Pick<
  SubsessionDelegationService,
  "activeParentDelegations" | "steerSteward" | "cancelSteward" |
    "consumeStewardDirection"
>;

export function createSubsessionControlService(
  input: SubsessionDelegationDependencies,
  childQueue: NativeInboundQueue,
): ControlService {
  return {
    async activeParentDelegations(parentInput) {
      return activeParentDelegations(input, parentInput);
    },
    async steerSteward(directionInput) {
      const instruction = requiredBoundedDirection(directionInput.instruction);
      const active = await resolveActiveRelation(input, directionInput);
      const instructionId = `steward-direction-${digest(stableJson({
        relation_id: active.relation.relation_id,
        source_message_id: directionInput.sourceMessageId,
        instruction,
      })).slice(0, 40)}`;
      const direction = input.store.createDirection({
        instruction_id: instructionId,
        relation_id: active.relation.relation_id,
        source_parent_turn_id: directionInput.sourceParentTurnId,
        source_message_id: directionInput.sourceMessageId,
        instruction,
        created_at: new Date().toISOString(),
      });
      if (direction.instruction_id !== instructionId || direction.instruction !== instruction) {
        throw new Error("steward_direction_identity_conflict");
      }
      return direction;
    },
    async cancelSteward(cancelInput) {
      const active = await resolveActiveRelation(input, cancelInput);
      const requestedAt = new Date().toISOString();
      const requestId = `cancel-steward-${digest(stableJson({
        relation_id: active.relation.relation_id,
        source_message_id: cancelInput.sourceMessageId,
      })).slice(0, 40)}`;
      childQueue.enqueueIdempotent(createAppCancellationEnvelope({
        chatId: active.relation.child_session_id,
        sessionId: active.relation.child_session_id,
        turnId: active.child_turn_id,
        requestId,
        requestedAt,
      }), {
        source: "btcc-steward-control",
        relation_id: active.relation.relation_id,
        source_parent_turn_id: cancelInput.sourceParentTurnId,
      });
      return { relation: active.relation, child_turn_id: active.child_turn_id,
        status: "cancelling" as const };
    },
    async consumeStewardDirection(directionInput) {
      const relation = input.store.relationByChildSessionId(directionInput.childSessionId);
      if (!relation || input.store.resultByRelationId(relation.relation_id)) return null;
      const storedTurnId = input.store.childTurnIdByRelationId(relation.relation_id);
      if (storedTurnId !== directionInput.childTurnId) {
        throw new Error("steward_direction_child_turn_mismatch");
      }
      return input.store.consumePendingDirection({
        relationId: relation.relation_id,
        childTurnId: directionInput.childTurnId,
      });
    },
  };
}

async function resolveActiveRelation(
  input: SubsessionDelegationDependencies,
  selector: { parentSessionId: string; relationId?: string; safeTitle?: string },
): Promise<{ relation: SessionRelation; child_turn_id: string }> {
  const candidates = input.store.relationsByParentSessionId(selector.parentSessionId)
    .filter((relation) => !input.store.resultByRelationId(relation.relation_id))
    .filter((relation) => !selector.relationId || relation.relation_id === selector.relationId)
    .filter((relation) => !selector.safeTitle || relation.safe_title === selector.safeTitle);
  const active: Array<{ relation: SessionRelation; child_turn_id: string }> = [];
  for (const relation of candidates) {
    const childTurnId = input.store.childTurnIdByRelationId(relation.relation_id);
    if (!childTurnId) continue;
    const turn = await input.parentTurns.findTurn(childTurnId);
    if (!turn || turn.semanticState === "admitted") {
      active.push({ relation, child_turn_id: childTurnId });
    }
  }
  if (active.length === 0) throw new Error("active_steward_relation_not_found");
  if (active.length !== 1) throw new Error("active_steward_relation_ambiguous");
  return active[0]!;
}

function requiredBoundedDirection(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("steward_direction_instruction_required");
  if (normalized.length > 1_200) throw new Error("steward_direction_instruction_too_long");
  return normalized;
}
