import { homedir } from "node:os";
import { join } from "node:path";
import type { GatewayDispatchResult, GatewayRouterLike } from "../../../gateways/core/contracts.ts";
import { DeliveryGuard } from "../delivery-guard.ts";
import type { OutboundAction } from "../../../test-support/harness/contracts.ts";
import type { TelegramInboundInput, TelegramTransportAdapter } from "./adapter.ts";
import { normalizeTelegramInbound } from "./adapter.ts";
import type { TelegramCallbackQueryInput, TelegramNativeControlPlane } from "./native-controls.ts";
import {
  applyComponentUpdate,
  checkComponentUpdates,
  renderServiceUpdateResult,
} from "../../../operations/update/component-updater.ts";

export interface TelegramLiveGatewayServer {
  handleInbound(envelope: ReturnType<typeof normalizeTelegramInbound>): Promise<GatewayDispatchResult>;
}

export interface TelegramLiveGatewayOptions {
  adapter: TelegramTransportAdapter;
  router: GatewayRouterLike;
  server: TelegramLiveGatewayServer;
  controls?: TelegramNativeControlPlane;
  renderStatus?: () => Promise<string> | string;
  renderHelp?: () => string;
  butlerHome?: string;
  butlerData?: string;
}

export type TelegramLiveGatewayResult =
  | {
      kind: "routed";
      dispatchStatus: GatewayDispatchResult["status"];
    }
  | {
      kind: "command";
      command: string;
      delivered: boolean;
    }
  | {
      kind: "unknown-command";
      delivered: boolean;
    };

export interface TelegramLiveGatewayCallbackResult {
  outcome: "handled" | "unknown" | "malformed";
  answers: Array<{
    text: string;
    showAlert: boolean;
  }>;
  delivered: boolean;
}

function parseCommand(text: string | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed?.startsWith("/")) return null;
  const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s|$)/.exec(trimmed);
  return match?.[1]?.toLowerCase() ?? null;
}

function buildHelpText(): string {
  return [
    "Butler commands:",
    "/status — system status snapshot",
    "/update — Butler Agent update check",
    "/help — show this help",
  ].join("\n");
}

function buildCommandAction(input: {
  envelope: ReturnType<typeof normalizeTelegramInbound>;
  text: string;
  source: string;
}): OutboundAction {
  const peer =
    input.envelope.peer.kind === "thread"
      ? {
          kind: "thread" as const,
          id: input.envelope.peer.parentId ?? input.envelope.peer.id,
          threadId: input.envelope.peer.id,
        }
      : {
          kind: input.envelope.peer.kind,
          id: input.envelope.peer.id,
        };

  return {
    actionId: `telegram-live:${input.envelope.message.id}:${input.source}`,
    transport: "telegram",
    accountId: input.envelope.accountId,
    peer,
    message: {
      text: input.text,
    },
    metadata: {
      source: input.source,
    },
  };
}

export function createTelegramLiveGateway(options: TelegramLiveGatewayOptions) {
  const guard = new DeliveryGuard({
    adapters: [options.adapter],
  });
  const butlerHome = options.butlerHome ?? process.env.BUTLER_HOME ?? process.cwd();
  const butlerData = options.butlerData ?? process.env.BUTLER_DATA ?? join(homedir(), ".butler");

  async function deliverCommandReply(
    envelope: ReturnType<typeof normalizeTelegramInbound>,
    text: string,
    source: string,
  ): Promise<boolean> {
    const route = options.router.routeInbound(envelope);
    const sessionId = route.status === "routed" ? route.route.sessionId : "telegram/control";
    const result = await guard.deliver(
      sessionId,
      buildCommandAction({
        envelope,
        text,
        source,
      }),
      {
        source,
      },
    );
    return result.ok;
  }

  return {
    async start(): Promise<void> {
      await options.adapter.start(async (event) => {
        await options.server.handleInbound(event);
      });
    },

    async handleMessage(input: TelegramInboundInput): Promise<TelegramLiveGatewayResult> {
      const envelope = normalizeTelegramInbound(input);
      if (options.controls) {
        const handled = await options.controls.handleMessage(input);
        if (handled) {
          return {
            kind: "command",
            command: handled.command,
            delivered: handled.deliveryCount > 0,
          };
        }
      }
      const command = parseCommand(input.text);

      if (command === "status") {
        const text = String(await (options.renderStatus ? options.renderStatus() : "status unavailable"));
        const delivered = await deliverCommandReply(
          envelope,
          text,
          "transport/telegram/live-gateway.ts#status",
        );
        return {
          kind: "command",
          command: "status",
          delivered,
        };
      }

      if (command === "help") {
        const text = options.renderHelp?.() ?? buildHelpText();
        const delivered = await deliverCommandReply(
          envelope,
          text,
          "transport/telegram/live-gateway.ts#help",
        );
        return {
          kind: "command",
          command: "help",
          delivered,
        };
      }

      if (command === "update") {
        const text = await runServiceUpdateSlashCommand(input.text, {
          butlerHome,
          butlerData,
        });
        const delivered = await deliverCommandReply(
          envelope,
          text,
          "transport/telegram/live-gateway.ts#update",
        );
        return {
          kind: "command",
          command: "update",
          delivered,
        };
      }

      if (command) {
        const delivered = await deliverCommandReply(
          envelope,
          "Unknown command. Try /help.",
          "transport/telegram/live-gateway.ts#unknown",
        );
        return {
          kind: "unknown-command",
          delivered,
        };
      }

      const result = await options.server.handleInbound(envelope);
      if (
        result.status === "handled" &&
        typeof result.handlerResult.metadata?.text === "string" &&
        result.handlerResult.metadata.text.trim()
      ) {
        await deliverCommandReply(
          envelope,
          result.handlerResult.metadata.text,
          "transport/telegram/live-gateway.ts#session-reply",
        );
      }
      return {
        kind: "routed",
        dispatchStatus: result.status,
      };
    },

    async handleCallbackQuery(input: TelegramCallbackQueryInput): Promise<TelegramLiveGatewayCallbackResult> {
      if (!options.controls) {
        return {
          outcome: "unknown",
          answers: [],
          delivered: false,
        };
      }

      const result = await options.controls.handleCallbackQuery(input);
      return {
        outcome: result.outcome,
        answers: result.answers,
        delivered: result.deliveryCount > 0,
      };
    },
  };
}

async function runServiceUpdateSlashCommand(
  text: string | undefined,
  options: { butlerHome: string; butlerData: string },
): Promise<string> {
  const action = parseUpdateAction(text);
  if (!action) return "Unknown update command. Use /update or /update apply.";
  try {
    if (action === "apply") {
      return renderServiceUpdateResult(await applyComponentUpdate({
        root: options.butlerHome,
        butlerData: options.butlerData,
        component: "service",
      }));
    }
    const view = await checkComponentUpdates({
      root: options.butlerHome,
      butlerData: options.butlerData,
      components: ["service"],
    });
    return renderServiceUpdateResult(view.components[0]!);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Butler Agent update failed: ${message}`;
  }
}

function parseUpdateAction(text: string | undefined): "check" | "apply" | null {
  const trimmed = text?.trim();
  if (trimmed === "/update" || trimmed === "/update check") return "check";
  if (trimmed === "/update apply") return "apply";
  return null;
}
