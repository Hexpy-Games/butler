import type { GatewayRouterLike } from "../../../gateways/core/contracts.ts";
import type { OutboundAction } from "../../../test-support/harness/contracts.ts";
import type { SessionStore as CommandSessionStore } from "../../../integrations/telegram/commands/session.ts";
import { parsePrincipalDecisionCallback, PlannedTaskStore } from "../../../agent/work/planned-task.ts";
import { DeliveryGuard } from "../delivery-guard.ts";
import type { TelegramForumApi, TelegramInlineKeyboardMarkup } from "./api.ts";
import { createTelegramForumApi } from "./api.ts";
import { normalizeTelegramInbound, type TelegramInboundInput, type TelegramTransportAdapter } from "./adapter.ts";

export interface TelegramCallbackQueryInput {
  chatId: string;
  chatType: TelegramInboundInput["chatType"];
  threadId?: string;
  messageId: string;
  senderId: string;
  senderDisplayName?: string;
  data: string;
  timestamp: string;
  raw?: unknown;
}

export interface TelegramNativeControlPlaneOptions {
  adapter: TelegramTransportAdapter;
  router: GatewayRouterLike;
  butlerData?: string;
  forum?: TelegramForumApi;
  now?: () => number;
  schedule?: (fn: () => void | Promise<void>, delayMs: number) => void;
  sessionTtlMs?: number;
}

export interface TelegramControlAnswer {
  text: string;
  showAlert: boolean;
}

export interface TelegramControlHandledResult {
  handled: true;
  command: string;
  deliveryCount: number;
}

export interface TelegramCallbackHandledResult {
  outcome: "handled" | "unknown" | "malformed";
  answers: TelegramControlAnswer[];
  deliveryCount: number;
}

export interface TelegramNativeControlPlane {
  handleMessage(input: TelegramInboundInput): Promise<TelegramControlHandledResult | null>;
  handleCallbackQuery(input: TelegramCallbackQueryInput): Promise<TelegramCallbackHandledResult>;
}

interface CommandModuleDeps {
  sessions: CommandSessionStore;
  sendMessage: (
    chatId: string,
    text: string,
    opts?: {
      reply_markup?: TelegramInlineKeyboardMarkup;
      parse_mode?: string;
    },
  ) => Promise<void>;
}

function defaultSchedule(fn: () => void | Promise<void>, delayMs: number): void {
  const timer = setTimeout(() => {
    void fn();
  }, delayMs);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
}

function parseSlashCommand(text: string | undefined): { command: string; args: string } | null {
  const trimmed = text?.trim();
  if (!trimmed?.startsWith("/")) return null;
  const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/.exec(trimmed);
  if (!match?.[1]) return null;
  return {
    command: match[1].toLowerCase(),
    args: match[2]?.trim() ?? "",
  };
}

function buildActionId(prefix: string, messageId: string, suffix: string): string {
  return `telegram-control:${prefix}:${messageId}:${suffix}`;
}

function buildPeer(
  envelope: ReturnType<typeof normalizeTelegramInbound>,
): OutboundAction["peer"] {
  if (envelope.peer.kind === "thread") {
    return {
      kind: "thread",
      id: envelope.peer.parentId ?? envelope.peer.id,
      threadId: envelope.peer.id,
    };
  }

  return {
    kind: envelope.peer.kind,
    id: envelope.peer.id,
  };
}

function routeSessionId(
  router: GatewayRouterLike,
  envelope: ReturnType<typeof normalizeTelegramInbound>,
): string {
  const routed = router.routeInbound(envelope);
  if (routed.status === "routed") return routed.route.sessionId;
  return "telegram/control";
}

function normalizeMarkup(value: unknown): TelegramInlineKeyboardMarkup | undefined {
  if (!value || typeof value !== "object") return undefined;
  const inlineKeyboard = (value as { inline_keyboard?: unknown }).inline_keyboard;
  if (!Array.isArray(inlineKeyboard)) return undefined;
  return value as TelegramInlineKeyboardMarkup;
}

function normalizeParseMode(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function createTelegramNativeControlPlane(
  options: TelegramNativeControlPlaneOptions,
): Promise<TelegramNativeControlPlane> {
  const [
    { SessionStore },
    { parseCallback },
    handlers,
    projectExt,
    topic,
  ] = await Promise.all([
    import("../../../integrations/telegram/commands/session.ts"),
    import("../../../integrations/telegram/commands/router.ts"),
    import("../../../integrations/telegram/commands/handlers.ts"),
    import("../../../integrations/telegram/commands/project-ext.ts"),
    import("../../../integrations/telegram/commands/topic.ts"),
  ]);

  const sessions = new SessionStore({
    ttlMs: options.sessionTtlMs,
    now: options.now,
  });
  const guard = new DeliveryGuard({
    adapters: [options.adapter],
  });
  const forum = options.forum ?? createTelegramForumApi();
  const schedule = options.schedule ?? defaultSchedule;
  const butlerData = options.butlerData ?? process.env.BUTLER_DATA ?? `${process.env.HOME ?? "."}/.butler`;

  function createDeliveryBridge(
    envelope: ReturnType<typeof normalizeTelegramInbound>,
    scope: string,
  ) {
    const attempts: unknown[] = [];
    const sessionId = routeSessionId(options.router, envelope);

    async function deliver(
      text: string,
      source: string,
      extra?: {
        parseMode?: string;
        replyMarkup?: TelegramInlineKeyboardMarkup;
        replyToMessageId?: string;
        editMessageId?: string;
      },
    ): Promise<void> {
      const action: OutboundAction = {
        actionId: buildActionId(scope, envelope.message.id, `${attempts.length + 1}`),
        transport: "telegram",
        accountId: envelope.accountId,
        peer: buildPeer(envelope),
        message: {
          text,
          replyToMessageId: extra?.replyToMessageId,
          editMessageId: extra?.editMessageId,
        },
        metadata: {
          source,
          ...(extra?.parseMode ? { parseMode: extra.parseMode } : {}),
          ...(extra?.replyMarkup ? { replyMarkup: extra.replyMarkup } : {}),
        },
      };

      attempts.push(
        await guard.deliver(sessionId, action, {
          source,
        }),
      );
    }

    return {
      attempts,
      createDeps(commandScope: string, defaultEditMessageId?: string): CommandModuleDeps {
        return {
          sessions,
          sendMessage: async (_chatId, text, opts) => {
            await deliver(text, `${scope}#${commandScope}:send`, {
              parseMode: normalizeParseMode(opts?.parse_mode),
              replyMarkup: normalizeMarkup(opts?.reply_markup),
              ...(defaultEditMessageId ? { editMessageId: defaultEditMessageId } : {}),
            });
          },
        };
      },
      createCallbackCtx(defaultEditMessageId: string) {
        const answers: TelegramControlAnswer[] = [];
        return {
          answers,
          ctx: {
            chatId: envelope.peer.parentId ?? envelope.peer.id,
            userId: envelope.sender.id,
            messageId: Number.parseInt(defaultEditMessageId, 10) || undefined,
            answer: async (text?: string, opts?: { showAlert?: boolean }) => {
              answers.push({
                text: text ?? "",
                showAlert: opts?.showAlert === true,
              });
            },
            editText: async (
              text: string,
              opts?: {
                reply_markup?: unknown;
                parse_mode?: string;
              },
            ) => {
              await deliver(text, `${scope}#callback:edit`, {
                parseMode: normalizeParseMode(opts?.parse_mode),
                replyMarkup: normalizeMarkup(opts?.reply_markup),
                editMessageId: defaultEditMessageId,
              });
            },
            sendText: async (
              text: string,
              opts?: {
                reply_markup?: unknown;
                parse_mode?: string;
              },
            ) => {
              await deliver(text, `${scope}#callback:send`, {
                parseMode: normalizeParseMode(opts?.parse_mode),
                replyMarkup: normalizeMarkup(opts?.reply_markup),
              });
            },
          },
        };
      },
    };
  }

  async function handleControlCommand(
    input: TelegramInboundInput,
    parsed: { command: string; args: string },
  ): Promise<TelegramControlHandledResult | null> {
    const envelope = normalizeTelegramInbound(input);
    const bridge = createDeliveryBridge(envelope, parsed.command);

    if (parsed.command === "help") {
      await handlers.onHelpCommand(bridge.createDeps("help"), {
        chatId: input.chatId,
        userId: input.senderId,
      });
      return {
        handled: true,
        command: "help",
        deliveryCount: bridge.attempts.length,
      };
    }

    if (parsed.command === "status") {
      await handlers.onStatusCommand(bridge.createDeps("status"), {
        chatId: input.chatId,
        userId: input.senderId,
      });
      return {
        handled: true,
        command: "status",
        deliveryCount: bridge.attempts.length,
      };
    }

    if (parsed.command === "model") {
      await handlers.onModelCommand(bridge.createDeps("model"), {
        chatId: input.chatId,
        userId: input.senderId,
      });
      return {
        handled: true,
        command: "model",
        deliveryCount: bridge.attempts.length,
      };
    }

    if (parsed.command === "persona") {
      await handlers.onPersonaCommand(bridge.createDeps("persona"), {
        chatId: input.chatId,
        userId: input.senderId,
      });
      return {
        handled: true,
        command: "persona",
        deliveryCount: bridge.attempts.length,
      };
    }

    if (parsed.command === "tasks") {
      await handlers.onTasksCommand(bridge.createDeps("tasks"), {
        chatId: input.chatId,
        userId: input.senderId,
      });
      return {
        handled: true,
        command: "tasks",
        deliveryCount: bridge.attempts.length,
      };
    }

    if (parsed.command === "restart") {
      await handlers.onRestartCommand(bridge.createDeps("restart"), {
        chatId: input.chatId,
        userId: input.senderId,
      });
      return {
        handled: true,
        command: "restart",
        deliveryCount: bridge.attempts.length,
      };
    }

    if (parsed.command === "kill") {
      await handlers.onKillCommand(bridge.createDeps("kill"), {
        chatId: input.chatId,
        userId: input.senderId,
      });
      return {
        handled: true,
        command: "kill",
        deliveryCount: bridge.attempts.length,
      };
    }

    if (parsed.command === "project") {
      const projectDeps = {
        ...bridge.createDeps("project"),
        schedule,
        now: options.now,
      };
      await projectExt.onProjectCommand(projectDeps, {
        chatId: input.chatId,
        userId: input.senderId,
        threadId: input.threadId ? Number.parseInt(input.threadId, 10) : null,
      });
      return {
        handled: true,
        command: "project",
        deliveryCount: bridge.attempts.length,
      };
    }

    if (parsed.command === "topic") {
      const topicDeps = {
        ...bridge.createDeps("topic"),
        forum,
        schedule,
        now: options.now,
      };
      if (parsed.args.toLowerCase() === "restore") {
        await topic.onTopicRestoreCommand(topicDeps, {
          chatId: input.chatId,
          userId: input.senderId,
          threadId: input.threadId ? Number.parseInt(input.threadId, 10) : null,
        });
      } else {
        await topic.onTopicCommand(topicDeps, {
          chatId: input.chatId,
          userId: input.senderId,
          threadId: input.threadId ? Number.parseInt(input.threadId, 10) : null,
        });
      }
      return {
        handled: true,
        command: "topic",
        deliveryCount: bridge.attempts.length,
      };
    }

    return null;
  }

  return {
    async handleMessage(input) {
      const parsed = parseSlashCommand(input.text);
      if (parsed) {
        return await handleControlCommand(input, parsed);
      }

      const envelope = normalizeTelegramInbound(input);
      const bridge = createDeliveryBridge(envelope, "followup");
      const topicDeps = {
        ...bridge.createDeps("topic-followup"),
        forum,
        schedule,
        now: options.now,
      };
      const projectDeps = {
        ...bridge.createDeps("project-followup"),
        schedule,
        now: options.now,
      };

      const sendConfirm = async (text: string, markup: TelegramInlineKeyboardMarkup) => {
        await bridge.createDeps("followup").sendMessage(input.chatId, text, {
          reply_markup: markup,
        });
      };

      if (
        typeof input.text === "string" &&
        (await topic.handleRenameInput(topicDeps, input.chatId, input.senderId, input.text, sendConfirm))
      ) {
        return {
          handled: true,
          command: "topic",
          deliveryCount: bridge.attempts.length,
        };
      }

      if (
        typeof input.text === "string" &&
        (await projectExt.handleManualPathInput(
          projectDeps,
          input.chatId,
          input.senderId,
          input.text,
          sendConfirm,
        ))
      ) {
        return {
          handled: true,
          command: "project",
          deliveryCount: bridge.attempts.length,
        };
      }

      return null;
    },

    async handleCallbackQuery(input) {
      const parsed = parseCallback(input.data);
      if (!parsed) {
        return {
          outcome: "malformed",
          answers: [],
          deliveryCount: 0,
        };
      }

      const envelope = normalizeTelegramInbound({
        chatId: input.chatId,
        chatType: input.chatType,
        threadId: input.threadId,
        messageId: input.messageId,
        text: undefined,
        senderId: input.senderId,
        senderDisplayName: input.senderDisplayName,
        timestamp: input.timestamp,
        raw: input.raw,
      });
      const bridge = createDeliveryBridge(envelope, parsed.prefix);
      const { answers, ctx } = bridge.createCallbackCtx(input.messageId);

      const baseDeps = bridge.createDeps(parsed.prefix, undefined);
      const topicDeps = {
        ...baseDeps,
        forum,
        schedule,
        now: options.now,
      };
      const projectDeps = {
        ...baseDeps,
        schedule,
        now: options.now,
      };

      if (parsed.prefix === handlers.MODEL_PREFIX) {
        await handlers.onModelCallback(baseDeps, parsed, ctx);
      } else if (parsed.prefix === handlers.PERSONA_PREFIX) {
        await handlers.onPersonaCallback(baseDeps, parsed, ctx);
      } else if (parsed.prefix === handlers.TASKS_PREFIX) {
        await handlers.onTasksCallback(baseDeps, parsed, ctx);
      } else if (parsed.prefix === handlers.RESTART_PREFIX) {
        await handlers.onRestartCallback(baseDeps, parsed, ctx);
      } else if (parsed.prefix === handlers.KILL_PREFIX) {
        await handlers.onKillCallback(baseDeps, parsed, ctx);
      } else if (parsed.prefix === projectExt.PROJECT_PREFIX) {
        await projectExt.onProjectCallback(projectDeps, parsed, ctx);
      } else if (parsed.prefix === topic.TOPIC_PREFIX) {
        await topic.onTopicCallback(topicDeps, parsed, ctx);
      } else if (parsed.prefix === topic.TOPIC_RESTORE_PREFIX) {
        await topic.onTopicRestoreCallback(topicDeps, parsed, ctx);
      } else if (parsed.prefix === "pd") {
        const decisionCallback = parsePrincipalDecisionCallback(input.data);
        if (!decisionCallback) {
          return {
            outcome: "malformed",
            answers,
            deliveryCount: bridge.attempts.length,
          };
        }
        const store = new PlannedTaskStore(butlerData);
        const record = store.answerDecision({
          decisionId: decisionCallback.decisionId,
          optionId: decisionCallback.optionId,
          transport: "telegram",
          actorId: input.senderId,
        });
        answers.push({
          text: "Decision recorded.",
          showAlert: false,
        });
        await ctx.editText(`Decision recorded: ${decisionCallback.optionId}`);
        await options.adapter.emitInbound({
          chatId: input.chatId,
          chatType: input.chatType,
          threadId: input.threadId,
          messageId: `decision:${input.messageId}:${Date.now()}`,
          senderId: "butler-decision-control",
          senderDisplayName: "Butler Decision Control",
          timestamp: input.timestamp,
          text: [
            "System event: principal decision answered.",
            `Planned task ID: ${record.taskId}`,
            `Decision ID: ${decisionCallback.decisionId}`,
            `Selected option: ${decisionCallback.optionId}`,
            "Resume the planned task according to the selected option.",
          ].join("\n"),
        });
      } else {
        return {
          outcome: "unknown",
          answers,
          deliveryCount: bridge.attempts.length,
        };
      }

      return {
        outcome: "handled",
        answers,
        deliveryCount: bridge.attempts.length,
      };
    },
  };
}
