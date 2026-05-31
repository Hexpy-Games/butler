import type { DeliveryResult, InboundEnvelope, OutboundAction, TransportAdapter } from "../../../test-support/harness/contracts.ts";
import type { TelegramInlineKeyboardMarkup, TelegramSendRequest } from "./api.ts";
import { sendTelegramChatActionViaBotApi, sendTelegramViaBotApi } from "./api.ts";
import {
  normalizeTelegramOutboundFormat,
  TELEGRAM_MARKDOWN_V2_PARSE_MODE,
  toTelegramMarkdownV2,
} from "./markdown-v2.ts";

export interface TelegramTransportAdapterOptions {
  butlerHome?: string;
  accountId?: string;
  botToken?: string;
  apiBase?: string;
  sendTelegram?: (input: TelegramSendRequest) => Promise<DeliveryResult>;
}

export interface TelegramInboundInput {
  chatId: string;
  chatType: "private" | "group" | "supergroup" | "channel";
  threadId?: string;
  messageId: string;
  text?: string;
  senderId: string;
  senderDisplayName?: string;
  timestamp: string;
  routingHints?: InboundEnvelope["routingHints"];
  raw?: unknown;
}

export interface TelegramTransportAdapter extends TransportAdapter {
  emitInbound(input: TelegramInboundInput): Promise<void>;
}

function toTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeReplyMarkup(value: unknown): TelegramInlineKeyboardMarkup | undefined {
  if (!value || typeof value !== "object") return undefined;
  const inlineKeyboard = (value as { inline_keyboard?: unknown }).inline_keyboard;
  if (!Array.isArray(inlineKeyboard)) return undefined;

  const normalizedRows = inlineKeyboard
    .map((row) => {
      if (!Array.isArray(row)) return [];
      return row
        .map((button) => {
          if (!button || typeof button !== "object") return null;
          const text = toTrimmedString((button as { text?: unknown }).text);
          const callbackData = toTrimmedString((button as { callback_data?: unknown }).callback_data);
          if (!text || !callbackData) return null;
          return {
            text,
            callback_data: callbackData,
          };
        })
        .filter((button): button is { text: string; callback_data: string } => button !== null);
    })
    .filter((row) => row.length > 0);

  if (normalizedRows.length === 0) return undefined;
  return {
    inline_keyboard: normalizedRows,
  };
}

function normalizeThreadId(threadId?: string | null): string | undefined {
  const trimmed = threadId?.trim();
  return trimmed ? trimmed : undefined;
}

function peerForInput(input: TelegramInboundInput): InboundEnvelope["peer"] {
  const threadId = normalizeThreadId(input.threadId);
  if (threadId) {
    return {
      kind: "thread",
      id: threadId,
      parentId: input.chatId,
    };
  }
  return {
    kind: input.chatType === "private" ? "dm" : input.chatType === "channel" ? "channel" : "group",
    id: input.chatId,
  };
}

export function normalizeTelegramInbound(
  input: TelegramInboundInput,
  accountId = "default",
): InboundEnvelope {
  const threadId = normalizeThreadId(input.threadId);
  return {
    eventId: `telegram:${input.chatId}:${threadId ?? "main"}:${input.messageId}`,
    transport: "telegram",
    accountId,
    peer: peerForInput(input),
    sender: {
      id: input.senderId,
      displayName: input.senderDisplayName,
    },
    message: {
      id: input.messageId,
      text: input.text,
      timestamp: input.timestamp,
    },
    routingHints: input.routingHints,
    raw: input.raw,
  };
}

export function createTelegramTransportAdapter(
  options: TelegramTransportAdapterOptions = {},
): TelegramTransportAdapter {
  const accountId = options.accountId?.trim() || "default";
  let onEvent: ((event: InboundEnvelope) => Promise<void>) | undefined;

  return {
    id: "telegram",
    capabilities: {
      supportsThreads: true,
      supportsMessageEdit: true,
      supportsReactions: false,
      supportsAttachments: false,
      supportsStreamingEdits: false,
      supportsPresence: true,
      supportsActivityEvents: false,
      supportsProgressDrafts: true,
      supportsFinalAggregateOnly: false,
    },
    async start(handler) {
      onEvent = handler;
    },
    async send(action: OutboundAction): Promise<DeliveryResult> {
      if (action.transport !== "telegram") {
        return {
          ok: false,
          error: `Telegram adapter cannot send transport ${action.transport}`,
        };
      }
      const threadId = action.peer.threadId?.trim() || undefined;
      const chatId = action.peer.id;
      if (action.presence?.kind === "typing") {
        return await sendTelegramChatActionViaBotApi({
          chatId,
          threadId,
          action: "typing",
        }, {
          botToken: options.botToken,
          apiBase: options.apiBase,
        });
      }

      const outboundFormat = normalizeTelegramOutboundFormat(action.metadata?.parseMode);
      const text = outboundFormat === "markdownv2"
        ? toTelegramMarkdownV2(action.message.text ?? "")
        : action.message.text ?? "";
      const parseMode = outboundFormat === "markdownv2" ? TELEGRAM_MARKDOWN_V2_PARSE_MODE : undefined;
      const replyMarkup = normalizeReplyMarkup(action.metadata?.replyMarkup);
      const replyToMessageId = action.message.replyToMessageId?.trim() || undefined;
      const editMessageId = action.message.editMessageId?.trim() || undefined;

      const request: TelegramSendRequest = {
        chatId,
        text,
        threadId,
        parseMode,
        replyToMessageId,
        editMessageId,
        replyMarkup,
      };

      if (options.sendTelegram) {
        return await options.sendTelegram(request);
      }

      return await sendTelegramViaBotApi(request, {
        botToken: options.botToken,
        apiBase: options.apiBase,
      });
    },
    async emitInbound(input: TelegramInboundInput) {
      if (!onEvent) {
        throw new Error("Telegram adapter has not been started");
      }
      await onEvent(normalizeTelegramInbound(input, accountId));
    },
  };
}
