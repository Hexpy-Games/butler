import type {
  GatewayDispatchResult,
  GatewayRoleHandler,
  GatewayRoleHandlers,
  GatewayRouterLike,
} from "./contracts.ts";
import { recordOperationalMetric } from "../../operations/metrics/operational-metrics.ts";

export interface CreateGatewayServerOptions {
  router: GatewayRouterLike;
  handlers: GatewayRoleHandlers;
  butlerData?: string;
}

function handlerForRole(
  handlers: GatewayRoleHandlers,
  role: keyof GatewayRoleHandlers,
): GatewayRoleHandler | undefined {
  return handlers[role];
}

export function createGatewayServer(options: CreateGatewayServerOptions) {
  return {
    async handleInbound(envelope: Parameters<GatewayRouterLike["routeInbound"]>[0]): Promise<GatewayDispatchResult> {
      const startedAt = Date.now();
      const routed = options.router.routeInbound(envelope);
      if (routed.status !== "routed") {
        recordOperationalMetric({
          category: "ingress",
          name: "handle_inbound",
          status: "skipped",
          durationMs: Date.now() - startedAt,
          dimensions: {
            transport: envelope.transport,
            peerKind: envelope.peer.kind,
            routeStatus: routed.status,
            reason: routed.reason,
          },
        }, { butlerData: options.butlerData });
        return routed;
      }

      const handler = handlerForRole(options.handlers, routed.route.role);
      if (!handler) {
        recordOperationalMetric({
          category: "ingress",
          name: "handle_inbound",
          status: "error",
          durationMs: Date.now() - startedAt,
          dimensions: {
            transport: envelope.transport,
            peerKind: envelope.peer.kind,
            routeStatus: "missing-handler",
            role: routed.route.role,
            reason: routed.route.reason,
          },
        }, { butlerData: options.butlerData });
        return {
          status: "missing-handler",
          route: routed.route,
        };
      }

      try {
        const handlerResult = await handler({
          envelope,
          route: routed.route,
        });

        recordOperationalMetric({
          category: "ingress",
          name: "handle_inbound",
          status: handlerResult.ok ? "ok" : "error",
          durationMs: Date.now() - startedAt,
          dimensions: {
            transport: envelope.transport,
            peerKind: envelope.peer.kind,
            routeStatus: "handled",
            role: routed.route.role,
            reason: routed.route.reason,
            handler: handlerResult.handledBy,
          },
        }, { butlerData: options.butlerData });

        return {
          status: "handled",
          route: routed.route,
          handlerResult,
        };
      } catch (error) {
        recordOperationalMetric({
          category: "ingress",
          name: "handle_inbound",
          status: "error",
          durationMs: Date.now() - startedAt,
          dimensions: {
            transport: envelope.transport,
            peerKind: envelope.peer.kind,
            routeStatus: "handler-error",
            role: routed.route.role,
            reason: routed.route.reason,
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
        }, { butlerData: options.butlerData });
        throw error;
      }
    },
  };
}
