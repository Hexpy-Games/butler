import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { TelegramLiveGatewayResult } from "./live-gateway.ts";
import type { TelegramInboundInput } from "./adapter.ts";

export interface TelegramPollingGateway {
  handleMessage(input: TelegramInboundInput): Promise<TelegramLiveGatewayResult>;
}

export interface TelegramPollingOptions {
  butlerData?: string;
  botToken?: string;
  apiBase?: string;
  gateway: TelegramPollingGateway;
  shouldStop?: () => boolean;
  log?: (line: string) => void;
  timeoutSec?: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  date?: number;
  text?: string;
  caption?: string;
  chat: {
    id: number | string;
    type?: "private" | "group" | "supergroup" | "channel";
  };
  from?: {
    id?: number | string;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
}

function getButlerData(explicit?: string): string {
  return explicit || process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function readEnvValue(path: string, key: string): string {
  if (!existsSync(path)) return "";
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`).exec(line);
    if (!match) continue;
    return match[1]!.trim().replace(/^['"]|['"]$/g, "");
  }
  return "";
}

function resolveBotToken(input: { explicit?: string; butlerData: string }): string {
  return input.explicit?.trim() ||
    process.env.TELEGRAM_BOT_TOKEN?.trim() ||
    readEnvValue(join(input.butlerData, ".env"), "TELEGRAM_BOT_TOKEN");
}

function offsetPath(butlerData: string): string {
  return join(butlerData, "state", "telegram-update-offset");
}

function readOffset(butlerData: string): number | undefined {
  try {
    const value = Number.parseInt(readFileSync(offsetPath(butlerData), "utf8").trim(), 10);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeOffset(butlerData: string, offset: number): void {
  const path = offsetPath(butlerData);
  mkdirSync(join(butlerData, "state"), { recursive: true });
  writeFileSync(path, `${offset}\n`, "utf8");
}

function displayName(from: TelegramMessage["from"]): string | undefined {
  if (!from) return undefined;
  if (from.username) return `@${from.username}`;
  return [from.first_name, from.last_name].filter(Boolean).join(" ") || undefined;
}

function toInboundInput(update: TelegramUpdate): TelegramInboundInput | null {
  const message = update.message ?? update.edited_message ?? update.channel_post;
  if (!message?.chat) return null;
  const text = message.text ?? message.caption ?? "";
  if (!text.trim()) return null;

  const chatType = message.chat.type ?? "private";
  return {
    chatId: String(message.chat.id),
    chatType,
    threadId: message.message_thread_id ? String(message.message_thread_id) : undefined,
    messageId: String(message.message_id),
    text,
    senderId: String(message.from?.id ?? message.chat.id),
    senderDisplayName: displayName(message.from),
    timestamp: new Date((message.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    raw: update,
  };
}

async function callTelegram<T>(
  apiBase: string,
  botToken: string,
  method: string,
  body: URLSearchParams,
): Promise<T> {
  const response = await fetch(`${apiBase}/bot${botToken}/${method}`, {
    method: "POST",
    body,
  });
  const payload = await response.json().catch(() => null) as {
    ok?: boolean;
    result?: T;
    description?: string;
  } | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.description || `Telegram ${method} failed with HTTP ${response.status}`);
  }
  return payload.result as T;
}

export async function runTelegramPolling(options: TelegramPollingOptions): Promise<void> {
  const butlerData = getButlerData(options.butlerData);
  const botToken = resolveBotToken({ explicit: options.botToken, butlerData });
  const apiBase = options.apiBase?.replace(/\/+$/, "") || process.env.TELEGRAM_API_URL?.replace(/\/+$/, "") || "https://api.telegram.org";
  const log = options.log ?? (() => {});
  const shouldStop = options.shouldStop ?? (() => false);
  const timeoutSec = options.timeoutSec ?? 10;

  if (!botToken) {
    log("Telegram polling disabled: TELEGRAM_BOT_TOKEN not set");
    return;
  }

  await callTelegram(apiBase, botToken, "deleteWebhook", new URLSearchParams({
    drop_pending_updates: "false",
  })).catch((error) => log(`Telegram deleteWebhook warning: ${error instanceof Error ? error.message : String(error)}`));

  let offset = readOffset(butlerData);
  log("Telegram polling started");

  while (!shouldStop()) {
    const body = new URLSearchParams({
      timeout: String(timeoutSec),
      allowed_updates: JSON.stringify(["message", "edited_message", "channel_post"]),
    });
    if (offset !== undefined) body.set("offset", String(offset));

    let updates: TelegramUpdate[];
    try {
      updates = await callTelegram<TelegramUpdate[]>(apiBase, botToken, "getUpdates", body);
    } catch (error) {
      log(`Telegram polling warning: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      writeOffset(butlerData, offset);
      const input = toInboundInput(update);
      if (!input) continue;
      try {
        const result = await options.gateway.handleMessage(input);
        log(`Telegram update ${update.update_id} handled: ${result.kind}`);
      } catch (error) {
        log(`Telegram update ${update.update_id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  log("Telegram polling stopped");
}
