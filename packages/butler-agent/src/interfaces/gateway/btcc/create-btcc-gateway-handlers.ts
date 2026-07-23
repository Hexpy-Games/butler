import type {
  GatewayRoleHandlers,
  GatewayRoute,
  GatewaySessionActor,
} from "../../../gateways/core/contracts.ts";
import type { InboundEnvelope } from "../../../test-support/harness/contracts.ts";

type BtccGatewayLifecycle = {
  actorForRoute(route: GatewayRoute): Promise<GatewaySessionActor>;
};

export function createBtccGatewayHandlers(
  lifecycle: BtccGatewayLifecycle,
): GatewayRoleHandlers {
  const handle = async (route: GatewayRoute, envelope: InboundEnvelope) => {
    const actor = await lifecycle.actorForRoute(route);
    const result = await actor.handleInbound(envelope, route);
    return {
      ok: true,
      handledBy: "btcc-turn-runtime",
      metadata: {
        text: result.text,
        artifacts: result.artifacts ?? [],
        generatedSessionTitle: result.generatedSessionTitle ?? null,
        loadedSkillNames: result.loadedSkillNames ?? [],
        durableFinalRecorded: durableFinalRecordedByActor(result.raw),
      },
    };
  };

  return {
    butler: ({ route, envelope }) => handle(route, envelope),
    steward: ({ route, envelope }) => handle(route, envelope),
  };
}

function durableFinalRecordedByActor(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return true;
  return (raw as Record<string, unknown>).durableFinalRecorded !== false;
}
