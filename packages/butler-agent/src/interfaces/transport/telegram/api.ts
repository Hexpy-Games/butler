import { homedir } from "os";
import { join } from "path";
import type { DeliveryResult } from "../../../test-support/harness/contracts.ts";

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export interface TelegramBotApiOptions {
  botToken?: string;
  apiBase?: string;
}

export interface TelegramSendRequest {
  chatId: string;
  text: string;
  threadId?: string;
  parseMode?: string;
  replyToMessageId?: string;
  editMessageId?: string;
  replyMarkup?: TelegramInlineKeyboardMarkup;
}

export interface TelegramChatActionRequest {
  chatId: string;
  action: "typing";
  threadId?: string;
}

export interface TelegramForumApi {
  editForumTopic(chatId: string | number, threadId: number, args: { name?: string }): Promise<unknown>;
  closeForumTopic(chatId: string | number, threadId: number): Promise<unknown>;
  reopenForumTopic(chatId: string | number, threadId: number): Promise<unknown>;
}

const TELEGRAM_TEXT_CHUNK_LIMIT = 3_900;

function splitTelegramText(text: string): string[] {
  if (text.length <= TELEGRAM_TEXT_CHUNK_LIMIT) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_TEXT_CHUNK_LIMIT) {
    const window = remaining.slice(0, TELEGRAM_TEXT_CHUNK_LIMIT);
    const splitAt = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(". "),
    );
    const end = splitAt > TELEGRAM_TEXT_CHUNK_LIMIT * 0.5 ? splitAt + 1 : TELEGRAM_TEXT_CHUNK_LIMIT;
    chunks.push(remaining.slice(0, end).trimEnd());
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function resolveBotTokenAsync(explicit?: string): Promise<string> {
  if (explicit?.trim()) return explicit.trim();

  const fromEnv = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const butlerData = process.env.BUTLER_DATA || join(homedir(), ".butler");
  const envPath = join(butlerData, ".env");
  try {
    const raw = await Bun.file(envPath).text();
    for (const line of raw.split(/\r?\n/)) {
      const match = /^\s*TELEGRAM_BOT_TOKEN\s*=\s*(.+)\s*$/.exec(line);
      if (match) {
        const value = match[1]?.trim().replace(/^['"]|['"]$/g, "");
        if (value) return value;
      }
    }
  } catch {
    // Ignore and fall through to the explicit error below.
  }

  return "";
}

function resolveApiBase(explicit?: string): string {
  return explicit?.trim() || process.env.TELEGRAM_API_URL?.trim() || "https://api.telegram.org";
}

async function callTelegramApi<T>(
  method: string,
  body: URLSearchParams,
  options: TelegramBotApiOptions = {},
): Promise<T> {
  const botToken = await resolveBotTokenAsync(options.botToken);
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN not set");
  }

  const response = await fetch(`${resolveApiBase(options.apiBase)}/bot${botToken}/${method}`, {
    method: "POST",
    body,
  });
  const payload = await response.json().catch(() => null) as {
    ok?: boolean;
    description?: string;
    result?: T;
  } | null;
  if (!response.ok || !payload?.ok) {
    const description =
      typeof payload?.description === "string"
        ? payload.description
        : `HTTP ${response.status}`;
    throw new Error(description);
  }
  return payload.result as T;
}

export async function sendTelegramViaBotApi(
  input: TelegramSendRequest,
  options: TelegramBotApiOptions = {},
): Promise<DeliveryResult> {
  const method = input.editMessageId?.trim() ? "editMessageText" : "sendMessage";
  const chunks = method === "sendMessage" ? splitTelegramText(input.text) : [input.text];
  const results: Array<{ message_id?: number }> = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const body = new URLSearchParams();
    body.set("chat_id", input.chatId);
    body.set("text", chunks[index]!);

    if (input.threadId?.trim()) body.set("message_thread_id", input.threadId.trim());
    if (input.parseMode?.trim()) body.set("parse_mode", input.parseMode.trim());
    if (input.replyToMessageId?.trim() && index === 0) {
      body.set("reply_to_message_id", input.replyToMessageId.trim());
    }
    if (input.replyMarkup && index === 0) body.set("reply_markup", JSON.stringify(input.replyMarkup));
    if (method === "editMessageText") {
      body.set("message_id", input.editMessageId!.trim());
    }

    results.push(await callTelegramApi<{ message_id?: number }>(method, body, options));
  }

  const result = results.at(-1);
  return {
    ok: true,
    transportMessageId:
      typeof result?.message_id === "number" ? String(result.message_id) : input.editMessageId,
    raw: results.length === 1 ? result : results,
  };
}

export async function sendTelegramChatActionViaBotApi(
  input: TelegramChatActionRequest,
  options: TelegramBotApiOptions = {},
): Promise<DeliveryResult> {
  const body = new URLSearchParams();
  body.set("chat_id", input.chatId);
  body.set("action", input.action);
  if (input.threadId?.trim()) body.set("message_thread_id", input.threadId.trim());

  const result = await callTelegramApi<boolean>("sendChatAction", body, options);
  return {
    ok: true,
    raw: result,
  };
}

export function createTelegramForumApi(options: TelegramBotApiOptions = {}): TelegramForumApi {
  return {
    async editForumTopic(chatId, threadId, args) {
      const body = new URLSearchParams();
      body.set("chat_id", String(chatId));
      body.set("message_thread_id", String(threadId));
      if (args.name?.trim()) body.set("name", args.name.trim());
      return await callTelegramApi("editForumTopic", body, options);
    },

    async closeForumTopic(chatId, threadId) {
      const body = new URLSearchParams();
      body.set("chat_id", String(chatId));
      body.set("message_thread_id", String(threadId));
      return await callTelegramApi("closeForumTopic", body, options);
    },

    async reopenForumTopic(chatId, threadId) {
      const body = new URLSearchParams();
      body.set("chat_id", String(chatId));
      body.set("message_thread_id", String(threadId));
      return await callTelegramApi("reopenForumTopic", body, options);
    },
  };
}
