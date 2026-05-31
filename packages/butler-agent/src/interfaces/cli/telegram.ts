import { deletePrivateEnvValue, readPrivateEnv, upsertPrivateEnvValue } from "./private-env.ts";
import { toTelegramMarkdownV2 } from "../transport/telegram/markdown-v2.ts";

export interface TelegramCliStatus {
  tokenConfigured: boolean;
  chatPaired: boolean;
  chatId: string | null;
  envPath: string;
}

export type TelegramFetch = (url: URL) => Promise<Response>;

export interface TelegramPairInput {
  butlerData: string;
  token: string;
  apiBase?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetcher?: TelegramFetch;
  now?: () => number;
}

export interface TelegramPairResult extends TelegramCliStatus {
  pairedAt: string;
}

export interface TelegramSendTestInput {
  butlerData: string;
  message?: string;
  apiBase?: string;
  fetcher?: TelegramFetch;
}

export interface TelegramSendTestResult {
  ok: boolean;
  chatId: string;
  messageId: string | null;
  sentAt: string;
}

export function redactTelegramToken(value: string, token: string): string {
  if (!token) return value;
  return value
    .replaceAll(token, "[redacted-telegram-token]")
    .replaceAll(encodeURIComponent(token), "[redacted-telegram-token]");
}

function envPath(butlerData: string): string {
  return `${butlerData.replace(/\/+$/, "")}/.env`;
}

export function buildTelegramCliStatus(butlerData: string): TelegramCliStatus {
  const env = readPrivateEnv(butlerData);
  const chatId = env.TELEGRAM_CHAT_ID?.trim() || null;
  return {
    tokenConfigured: Boolean(env.TELEGRAM_BOT_TOKEN?.trim()),
    chatPaired: Boolean(chatId),
    chatId,
    envPath: envPath(butlerData),
  };
}

export function unpairTelegramChat(butlerData: string): {
  removed: boolean;
  status: TelegramCliStatus;
} {
  const removed = deletePrivateEnvValue(butlerData, "TELEGRAM_CHAT_ID");
  return {
    removed,
    status: buildTelegramCliStatus(butlerData),
  };
}

function chatIdFromUpdate(update: Record<string, any>): string | null {
  const message = update.message ?? update.edited_message ?? update.channel_post ?? update.my_chat_member;
  const id = message?.chat?.id;
  if (typeof id === "number" || typeof id === "string") return String(id);
  return null;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pairTelegramChat(input: TelegramPairInput): Promise<TelegramPairResult> {
  const apiBase = (input.apiBase || process.env.BUTLER_TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
  const timeoutMs = input.timeoutMs ?? 0;
  const pollIntervalMs = input.pollIntervalMs ?? 1_000;
  const fetcher = input.fetcher ?? ((url: URL) => fetch(url));
  const now = input.now ?? Date.now;
  const started = now();
  let offset: number | null = null;

  while (timeoutMs <= 0 || now() - started <= timeoutMs) {
    const url = new URL(`${apiBase}/bot${input.token}/getUpdates`);
    url.searchParams.set("timeout", "20");
    if (offset !== null) url.searchParams.set("offset", String(offset));
    let response: Response;
    try {
      response = await fetcher(url);
    } catch (error) {
      if (error instanceof Error) {
        error.message = redactTelegramToken(error.message, input.token);
        throw error;
      }
      throw new Error(redactTelegramToken(String(error), input.token), { cause: error });
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const detail = body ? `: ${body}` : "";
      throw new Error(redactTelegramToken(
        `Telegram getUpdates failed (${response.status})${detail}`,
        input.token,
      ));
    }
    let payload: {
      ok?: boolean;
      result?: Array<Record<string, any>>;
      description?: string;
    };
    try {
      payload = await response.json() as typeof payload;
    } catch {
      throw new Error("Telegram getUpdates returned malformed JSON");
    }
    if (payload.ok === false) {
      throw new Error(redactTelegramToken(
        payload.description || "Telegram getUpdates returned ok=false",
        input.token,
      ));
    }
    for (const update of payload.result ?? []) {
      if (typeof update.update_id === "number") offset = update.update_id + 1;
      const chatId = chatIdFromUpdate(update);
      if (!chatId) continue;
      upsertPrivateEnvValue(input.butlerData, "TELEGRAM_BOT_TOKEN", input.token);
      upsertPrivateEnvValue(input.butlerData, "TELEGRAM_CHAT_ID", chatId);
      return {
        ...buildTelegramCliStatus(input.butlerData),
        pairedAt: new Date(now()).toISOString(),
      };
    }
    await sleep(pollIntervalMs);
  }

  throw new Error("Telegram pairing timed out while waiting for a message");
}

export async function sendTelegramTestMessage(input: TelegramSendTestInput): Promise<TelegramSendTestResult> {
  const env = readPrivateEnv(input.butlerData);
  const token = env.TELEGRAM_BOT_TOKEN?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
  const chatId = env.TELEGRAM_CHAT_ID?.trim() || process.env.TELEGRAM_CHAT_ID?.trim() || "";
  if (!token) throw new Error("Telegram bot token is not configured");
  if (!chatId) throw new Error("Telegram chat is not paired");

  const apiBase = (input.apiBase || process.env.BUTLER_TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
  const fetcher = input.fetcher ?? ((url: URL) => fetch(url));
  const url = new URL(`${apiBase}/bot${token}/sendMessage`);
  url.searchParams.set("chat_id", chatId);
  url.searchParams.set("text", toTelegramMarkdownV2(input.message?.trim() || "Butler Telegram delivery test."));
  url.searchParams.set("parse_mode", "MarkdownV2");

  let response: Response;
  try {
    response = await fetcher(url);
  } catch (error) {
    if (error instanceof Error) {
      error.message = redactTelegramToken(error.message, token);
      throw error;
    }
    throw new Error(redactTelegramToken(String(error), token), { cause: error });
  }
  const body = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(redactTelegramToken(`Telegram sendMessage failed (${response.status})${body ? `: ${body}` : ""}`, token));
  }
  let payload: {
    ok?: boolean;
    result?: {
      message_id?: number | string;
    };
    description?: string;
  };
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    throw new Error("Telegram sendMessage returned malformed JSON");
  }
  if (payload.ok === false) {
    throw new Error(redactTelegramToken(payload.description || "Telegram sendMessage returned ok=false", token));
  }

  return {
    ok: true,
    chatId,
    messageId: payload.result?.message_id === undefined ? null : String(payload.result.message_id),
    sentAt: new Date().toISOString(),
  };
}
