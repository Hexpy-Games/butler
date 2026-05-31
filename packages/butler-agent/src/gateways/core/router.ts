import type { StoredSessionBinding } from "../../test-support/harness/contracts.ts";
import { SessionBindingStore } from "../../test-support/harness/session-store.ts";
import type { GatewayRoute, GatewayRouteResult, InboundEnvelope } from "./contracts.ts";

const ACTIVE_STATES: Array<StoredSessionBinding["lifecycleState"]> = ["active", "closing"];

export interface GatewayRouterOptions {
  store: SessionBindingStore;
}

interface TransportLookup {
  peerId: string;
  threadId?: string;
}

function trim(value?: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function toTransportLookup(envelope: InboundEnvelope): TransportLookup {
  if (envelope.peer.kind === "thread") {
    return {
      peerId: trim(envelope.peer.parentId) || envelope.peer.id,
      threadId: trim(envelope.peer.id),
    };
  }

  return {
    peerId: envelope.peer.id,
  };
}

function hasExactTransportBinding(
  session: StoredSessionBinding,
  envelope: InboundEnvelope,
  lookup: TransportLookup,
): boolean {
  return session.transportBindings.some((binding) =>
    binding.transport === envelope.transport &&
    binding.accountId === envelope.accountId &&
    binding.peerId === lookup.peerId &&
    trim(binding.threadId) === trim(lookup.threadId),
  );
}

function toRoute(session: StoredSessionBinding, reason: GatewayRoute["reason"]): GatewayRoute {
  return {
    sessionId: session.sessionId,
    role: session.role,
    reason,
    workspacePath: session.workspacePath,
    projectId: session.projectId,
  };
}

export class GatewayRouter {
  constructor(private readonly options: GatewayRouterOptions) {}

  routeInbound(envelope: InboundEnvelope): GatewayRouteResult {
    const sessionId = trim(envelope.routingHints?.sessionId);
    const stewardId = trim(envelope.routingHints?.stewardId);
    const projectId = trim(envelope.routingHints?.projectId);
    const lookup = toTransportLookup(envelope);

    if (sessionId) {
      const hinted = this.options.store.getBySessionId(sessionId);
      if (
        hinted &&
        ACTIVE_STATES.some((state) => state === hinted.lifecycleState) &&
        (hinted.role === "butler" || hinted.role === "steward")
      ) {
        return {
          status: "routed",
          route: toRoute(hinted, "session-hint"),
        };
      }
    }

    if (stewardId) {
      const hinted = this.options.store.getBySessionId(stewardId);
      if (hinted && ACTIVE_STATES.some((state) => state === hinted.lifecycleState) && hinted.role === "steward") {
        return {
          status: "routed",
          route: toRoute(hinted, "steward-hint"),
        };
      }
    }

    if (projectId) {
      const sessions = this.options.store.listSessions({ lifecycleState: [...ACTIVE_STATES] });
      const steward = sessions.find((session) => session.role === "steward" && session.projectId === projectId);
      if (steward) {
        return {
          status: "routed",
          route: toRoute(steward, "project-hint"),
        };
      }
    }

    const binding = this.options.store.resolveTransportBinding({
      transport: envelope.transport,
      accountId: envelope.accountId,
      peerId: lookup.peerId,
      threadId: lookup.threadId,
    });
    if (binding) {
      return {
        status: "routed",
        route: toRoute(
          binding,
          lookup.threadId && !hasExactTransportBinding(binding, envelope, lookup)
            ? "butler-fallback"
            : "transport-binding",
        ),
      };
    }

    return {
      status: "unroutable",
      reason: "missing-session",
      details: {
        transport: envelope.transport,
        accountId: envelope.accountId,
        peerId: lookup.peerId,
        threadId: lookup.threadId,
        sessionId,
        projectId,
        stewardId,
      },
    };
  }
}
