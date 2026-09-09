import { createAppCancellationEnvelope } from "../../../gateways/core/app-transport.ts";
import type { NativeInboundQueue } from "../../../gateways/core/inbound-queue.ts";
import { digest, stableJson } from "../identity/index.ts";
import type {
  SessionRelation,
  StewardDirection,
  SubsessionDelegationDependencies,
  SubsessionDelegationService,
} from "./contracts.ts";
import { activeParentDelegations } from "./active-parent-delegation.ts";
import { resolveStewardFollowup } from "./steward-followup.ts";

type ControlService = Pick<
  SubsessionDelegationService,
  "activeParentDelegations" | "activeChildCancellationTarget" | "steerSteward" | "cancelSteward" |
    "consumeStewardDirection"
>;

export function createSubsessionControlService(
  input: SubsessionDelegationDependencies,
  childQueue: NativeInboundQueue,
): ControlService & { recoverPendingDirections(): Promise<void> } {
  const activeChildCancellationTarget: ControlService["activeChildCancellationTarget"] = async (childSessionId) => {
    const relation = input.store.relationByChildSessionId(childSessionId);
    if (!relation) return null;
    const active = (await activeParentDelegations(input, {
      parentSessionId: relation.parent_session_id,
    })).find((candidate) => candidate.relation.relation_id === relation.relation_id);
    if (!active) return null;
    const latest = await input.parentTurns.findLatestTurnForSession(childSessionId);
    return { relation, child_turn_id: latest?.turnId ?? active.child_turn_id };
  };
  return {
    async recoverPendingDirections() {
      const recovered = new Set<string>();
      for (const direction of input.store.pendingDirections()) {
        if (recovered.has(direction.relation_id)) continue;
        recovered.add(direction.relation_id);
        const relation = input.store.relationById(direction.relation_id);
        if (!relation) throw new Error("subsession_direction_relation_missing");
        const latest = await input.parentTurns.findLatestTurnForSession(relation.child_session_id);
        if (!latest || latest.semanticState !== "admitted" || latest.suspension) {
          await enqueueDirectionContinuation(input, childQueue, relation, direction);
        }
      }
    },
    activeChildCancellationTarget,
    async activeParentDelegations(parentInput) {
      return activeParentDelegations(input, parentInput);
    },
    async steerSteward(directionInput) {
      const instruction = requiredBoundedDirection(directionInput.instruction);
      const active = await resolveStewardFollowup(input, directionInput)
        ?? await resolveActiveRelation(input, directionInput);
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
      const childTurn = await input.parentTurns.findLatestTurnForSession(
        active.relation.child_session_id,
      ) ?? await input.parentTurns.findTurn(active.child_turn_id);
      if (childTurn && (childTurn.semanticState !== "admitted" || childTurn.suspension)) {
        await enqueueDirectionContinuation(input, childQueue, active.relation, direction);
      }
      return direction;
    },
    async cancelSteward(cancelInput) {
      const selected = await resolveActiveRelation(input, cancelInput);
      const active = await activeChildCancellationTarget(selected.relation.child_session_id);
      if (!active) throw new Error("active_steward_relation_not_found");
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
      if (!relation) return null;
      return input.store.consumePendingDirection({
        relationId: relation.relation_id,
        childTurnId: directionInput.childTurnId,
      });
    },
  };
}

async function enqueueDirectionContinuation(
  input: SubsessionDelegationDependencies,
  childQueue: NativeInboundQueue,
  relation: SessionRelation,
  requestedDirection: StewardDirection,
): Promise<void> {
  // Several directions arriving before admission share one queued continuation.
  // Safe-boundary consumption still applies each durable revision in order.
  const direction = input.store.pendingDirections().find((candidate) =>
    candidate.relation_id === relation.relation_id,
  ) ?? requestedDirection;
  const child = input.sessionBindings.getBySessionId(relation.child_session_id);
  if (!child || (child.role !== "steward" && child.role !== "worker")) {
    throw new Error("subsession_direction_child_binding_missing");
  }
  const turnId = `subsession-direction-turn-${digest(direction.instruction_id).slice(0, 32)}`;
  if (child.role === "steward") {
    const rootWorkId = input.store.rootWorkIdByRelationId(relation.relation_id);
    if (!rootWorkId) throw new Error("subsession_direction_work_missing");
    // ensureChildRootWork binds this exact root only after the Turn is admitted.
    // A queued envelope is not yet a Turn and cannot own a durable Work binding.
  }
  childQueue.enqueueIdempotent({
    eventId: `subsession-direction:${direction.instruction_id}`,
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: relation.child_session_id, parentId: relation.parent_session_id },
    sender: {
      id: child.role === "worker" ? "steward-worker-direction" : "butler-steward-direction",
      displayName: child.role === "worker" ? "Steward" : "Butler",
    },
    message: {
      id: `subsession-direction-message:${direction.instruction_id}`,
      text: `${direction.instruction}\n\nContinue the existing Work from its retained checkpoint. Review the new direction against the existing result; do not restart completed actions or create a replacement Work.`,
      timestamp: direction.created_at,
    },
    routingHints: { sessionId: relation.child_session_id, turnId },
    nativeStewardContext: {
      version: 1,
      role: child.role,
      projectName: child.projectId ?? "",
      workspacePath: child.workspacePath,
      modelRef: child.modelRef,
      ...(typeof child.metadata?.reasoning_effort === "string"
        ? { reasoningEffort: child.metadata.reasoning_effort }
        : {}),
    },
    raw: { source: "btcc-subsession-direction", instruction_id: direction.instruction_id },
  });
}

async function resolveActiveRelation(
  input: SubsessionDelegationDependencies,
  selector: { parentSessionId: string; relationId?: string; safeTitle?: string },
): Promise<{ relation: SessionRelation; child_turn_id: string }> {
  const owned = await activeParentDelegations(input, {
    parentSessionId: selector.parentSessionId,
  });
  const active = owned.filter(({ relation }) => selector.relationId
    ? relation.relation_id === selector.relationId
    : !selector.safeTitle || relation.safe_title === selector.safeTitle);
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
