export const TURN_INTERRUPTION_PRODUCER_REGISTRY_SCHEMA =
  "butler.turn-interruption-producer-registry.v1" as const;

export type TurnInterruptionOrigin =
  | "admission"
  | "queue_handoff"
  | "dispatch"
  | "phase_runtime"
  | "continuation_handoff"
  | "tracking_closeout"
  | "delivery_outbox"
  | "projection"
  | "legacy_responder";

export type TurnInterruptionTarget =
  | "admission_reconciliation"
  | "turn_interruption_router"
  | "typed_agent_outbox_projection";

export interface TurnInterruptionProducerDescriptor {
  id: string;
  origin: TurnInterruptionOrigin;
  modulePath: string;
  boundary: string;
  entryRoots: readonly string[];
  legacyFailureAuthorities: readonly string[];
  requiredTarget: TurnInterruptionTarget;
  migrationStatus: "legacy" | "routed";
}

export const TURN_INTERRUPTION_PRODUCERS = [
  producer("app_message_admission", "admission", "gateways/app/domain/sessions/user-message-turn-store.ts", "enqueueAppTransportTurn", ["app"], ["failed App turn"], "admission_reconciliation"),
  producer("app_queue_handoff", "queue_handoff", "gateways/app/infrastructure/transport/transport-queue-store.ts", "waitAppTransportQueueHandoff", ["app"], ["assistant failure", "failed App turn"], "turn_interruption_router", "routed"),
  producer("queued_claim_failure", "dispatch", "interfaces/gateway/queued-inbound.ts", "failQueueClaim", ["queued", "automation", "recovery"], ["failed queue claim"], "turn_interruption_router", "routed"),
  producer("native_turn_catch", "phase_runtime", "agent/turn/native/turn-runner/turn-runner.ts", "principalCancelled", ["queued", "direct"], ["turn.failed event"], "turn_interruption_router", "routed"),
  producer("direct_responder_completion", "legacy_responder", "gateways/app/domain/sessions/responder-turn-lifecycle.ts", "completeResponderTurn", ["direct"], ["failed App turn"], "turn_interruption_router", "routed"),
  producer("user_responder_failure", "legacy_responder", "gateways/app/domain/sessions/user-message-responder-turn.ts", "routeResponderRuntimeInterruption", ["direct"], ["failed App turn"], "turn_interruption_router", "routed"),
  producer("system_responder_failure", "legacy_responder", "gateways/app/domain/sessions/system-responder-turn-store.ts", "handleError", ["system", "automation"], ["failed App turn"], "turn_interruption_router", "routed"),
  producer("app_failure_projection", "projection", "gateways/app/infrastructure/transport/projected-turn-failure.ts", "projectAppTurnFailure", ["app", "queued"], ["turn.failed event", "runtime_fault state", "failed state"], "turn_interruption_router", "routed"),
  producer("app_safe_failure_projection", "projection", "gateways/app/infrastructure/transport/turn-failure-projection.ts", "projectSafeTurnFailure", ["app", "queued"], ["gateway_failed fallback"], "typed_agent_outbox_projection"),
  producer("app_failure_ux", "projection", "gateways/app/infrastructure/transport/failure-ux-contract.ts", "appSafeResponderError", ["app", "direct", "system"], ["gateway_failed fallback", "timeout failure copy"], "typed_agent_outbox_projection"),
  producer("app_responder_timeout", "legacy_responder", "gateways/app/infrastructure/transport/responder-timeout.ts", "AppResponderTimeoutError", ["direct", "system"], ["timeout terminal"], "turn_interruption_router", "routed"),
  producer("provider_runtime_failure", "phase_runtime", "integrations/providers/provider-errors.ts", "safeRuntimeFailure", ["queued", "direct", "system", "automation", "recovery", "legacy"], ["gateway_failed fallback"], "turn_interruption_router"),
  producer("operational_failure_classifier", "phase_runtime", "agent/turn/operational-failure.ts", "isOperationalFailure", ["queued", "direct", "system", "automation", "recovery", "legacy"], ["message-derived terminal failure"], "turn_interruption_router"),
  producer("goal_completion_incomplete", "phase_runtime", "agent/turn/native/policy/turn-errors.ts", "goalCompletionIncompleteError", ["queued", "direct"], ["budget or completion terminal"], "turn_interruption_router"),
  producer("completion_review_incomplete", "phase_runtime", "agent/output/completion/final-output-contract.ts", "completionReviewIncompleteReason", ["queued", "direct"], ["completion terminal"], "turn_interruption_router"),
] as const satisfies readonly TurnInterruptionProducerDescriptor[];

export const TURN_INTERRUPTION_PRODUCER_COUNT = 15;

export function validateTurnInterruptionProducerRegistry(
  producers: readonly TurnInterruptionProducerDescriptor[] = TURN_INTERRUPTION_PRODUCERS,
): void {
  const ids = new Set<string>();
  for (const item of producers) {
    if (!item.id.trim()) throw new Error("turn_interruption_producer_id_missing");
    if (ids.has(item.id)) {
      throw new Error(`turn_interruption_producer_id_duplicate:${item.id}`);
    }
    ids.add(item.id);
    if (!item.modulePath.endsWith(".ts") || item.modulePath.startsWith("/")) {
      throw new Error(`turn_interruption_producer_module_invalid:${item.id}`);
    }
    if (!item.boundary.trim()) {
      throw new Error(`turn_interruption_producer_boundary_missing:${item.id}`);
    }
    if (item.entryRoots.length === 0) {
      throw new Error(`turn_interruption_producer_entry_root_missing:${item.id}`);
    }
    if (item.legacyFailureAuthorities.length === 0) {
      throw new Error(`turn_interruption_producer_legacy_authority_missing:${item.id}`);
    }
  }
}

function producer(
  id: string,
  origin: TurnInterruptionOrigin,
  modulePath: string,
  boundary: string,
  entryRoots: readonly string[],
  legacyFailureAuthorities: readonly string[],
  requiredTarget: TurnInterruptionTarget,
  migrationStatus: TurnInterruptionProducerDescriptor["migrationStatus"] = "legacy",
): TurnInterruptionProducerDescriptor {
  return {
    id,
    origin,
    modulePath,
    boundary,
    entryRoots,
    legacyFailureAuthorities,
    requiredTarget,
    migrationStatus,
  };
}
