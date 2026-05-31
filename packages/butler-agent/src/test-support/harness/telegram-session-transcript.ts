import { basename, extname } from "path";
import { randomUUID } from "crypto";
import type { AttachmentRef, InboundEnvelope, OutboundAction, StoredSessionBinding } from "./contracts.ts";
import { recordDurableInbound, recordDurableOutbound } from "./durable-session-transcript.ts";
import { SessionBindingStore } from "./session-store.ts";

export const DEFAULT_TELEGRAM_ACCOUNT_ID = "default";

export interface TelegramSessionLookupInput {
  chatId: string;
  threadId?: string;
  accountId?: string;
  requireExactThread?: boolean;
  dbPath?: string;
}

export interface TelegramInboundRecordInput extends TelegramSessionLookupInput {
  sessionId?: string;
  peerKind?: InboundEnvelope["peer"]["kind"];
  messageId?: string;
  text?: string;
  attachments?: AttachmentRef[];
  senderId?: string;
  senderDisplayName?: string;
  timestamp?: string;
  projectId?: string;
  stewardId?: string;
  route?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  raw?: unknown;
}

export interface TelegramOutboundRecordInput extends TelegramSessionLookupInput {
  sessionId?: string;
  text?: string;
  files?: string[];
  attachments?: AttachmentRef[];
  replyToMessageId?: string;
  editMessageId?: string;
  transportMessageIds?: string[];
  ok?: boolean;
  error?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
  raw?: unknown;
}

export interface RecordedTelegramTranscript {
  session: StoredSessionBinding;
}

function normalizeThreadId(threadId?: string | null): string | undefined {
  const trimmed = threadId?.trim();
  return trimmed ? trimmed : undefined;
}

function hasExactTelegramBinding(
  session: StoredSessionBinding,
  chatId: string,
  threadId: string,
  accountId: string,
): boolean {
  return session.transportBindings.some((binding) =>
    binding.transport === "telegram" &&
    binding.accountId === accountId &&
    binding.peerId === chatId &&
    binding.threadId === threadId,
  );
}

function resolveWithStore(store: SessionBindingStore, input: TelegramSessionLookupInput): StoredSessionBinding | null {
  const accountId = input.accountId?.trim() || DEFAULT_TELEGRAM_ACCOUNT_ID;
  const threadId = normalizeThreadId(input.threadId);
  const session = store.resolveTransportBinding({
    transport: "telegram",
    accountId,
    peerId: input.chatId,
    threadId,
  });
  if (!session) return null;
  if (threadId && input.requireExactThread && !hasExactTelegramBinding(session, input.chatId, threadId, accountId)) {
    return null;
  }
  return session;
}

function loadSession(
  store: SessionBindingStore,
  input: { sessionId?: string } & TelegramSessionLookupInput,
): StoredSessionBinding | null {
  if (input.sessionId?.trim()) {
    const explicit = store.getBySessionId(input.sessionId.trim());
    if (explicit) return explicit;
  }
  return resolveWithStore(store, input);
}

function guessAttachmentKind(filePath: string): AttachmentRef["kind"] {
  const ext = extname(filePath).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"].includes(ext)) return "image";
  if ([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"].includes(ext)) return "audio";
  if ([".mp4", ".mov", ".avi", ".webm", ".mkv"].includes(ext)) return "video";
  return "document";
}

function attachmentRefsFromFiles(files: string[] | undefined): AttachmentRef[] | undefined {
  if (!files?.length) return undefined;
  return files.map((filePath, index) => ({
    id: `file-${index + 1}`,
    kind: guessAttachmentKind(filePath),
    fileName: basename(filePath),
    localPath: filePath,
  }));
}

function inboundPeer(input: TelegramInboundRecordInput): InboundEnvelope["peer"] {
  const threadId = normalizeThreadId(input.threadId);
  if (threadId) {
    return {
      kind: "thread",
      id: threadId,
      parentId: input.chatId,
    };
  }
  return {
    kind: input.peerKind ?? "group",
    id: input.chatId,
  };
}

function outboundPeer(input: TelegramOutboundRecordInput): OutboundAction["peer"] {
  const threadId = normalizeThreadId(input.threadId);
  if (threadId) {
    return {
      kind: "thread",
      id: input.chatId,
      threadId,
    };
  }
  return {
    kind: "group",
    id: input.chatId,
  };
}

function inboundEventId(input: TelegramInboundRecordInput): string {
  const key = input.messageId?.trim() || input.timestamp?.trim() || randomUUID();
  return `telegram:${input.chatId}:${normalizeThreadId(input.threadId) ?? "main"}:${key}`;
}

function outboundActionId(input: TelegramOutboundRecordInput): string {
  const key =
    input.editMessageId?.trim() ||
    input.transportMessageIds?.[0]?.trim() ||
    input.timestamp?.trim() ||
    randomUUID();
  return `telegram-out:${input.chatId}:${normalizeThreadId(input.threadId) ?? "main"}:${key}`;
}

export function resolveTelegramSession(input: TelegramSessionLookupInput): StoredSessionBinding | null {
  const store = new SessionBindingStore(input.dbPath);
  try {
    return resolveWithStore(store, input);
  } finally {
    store.close();
  }
}

export function recordResolvedTelegramInbound(input: TelegramInboundRecordInput): RecordedTelegramTranscript | null {
  const store = new SessionBindingStore(input.dbPath);
  try {
    const session = loadSession(store, input);
    if (!session) return null;
    const timestamp = input.timestamp || new Date().toISOString();
    recordDurableInbound({
      sessionId: session.sessionId,
      timestamp,
      envelope: {
        eventId: inboundEventId(input),
        transport: "telegram",
        accountId: input.accountId?.trim() || DEFAULT_TELEGRAM_ACCOUNT_ID,
        peer: inboundPeer(input),
        sender: {
          id: input.senderId?.trim() || "telegram-user",
          displayName: input.senderDisplayName?.trim() || undefined,
        },
        message: {
          id: input.messageId?.trim() || `msg-${randomUUID()}`,
          text: input.text,
          attachments: input.attachments,
          timestamp,
        },
        routingHints: {
          projectId: input.projectId ?? session.projectId,
          stewardId: input.stewardId,
        },
        raw: input.raw,
      },
      route: input.route,
      metadata: input.metadata,
    });
    const updated = store.touchSession(session.sessionId, timestamp) ?? session;
    return { session: updated };
  } finally {
    store.close();
  }
}

export function recordResolvedTelegramOutbound(input: TelegramOutboundRecordInput): RecordedTelegramTranscript | null {
  const store = new SessionBindingStore(input.dbPath);
  try {
    const session = loadSession(store, {
      ...input,
      requireExactThread: input.requireExactThread ?? Boolean(normalizeThreadId(input.threadId)),
    });
    if (!session) return null;
    const timestamp = input.timestamp || new Date().toISOString();
    recordDurableOutbound({
      sessionId: session.sessionId,
      timestamp,
      action: {
        actionId: outboundActionId(input),
        transport: "telegram",
        accountId: input.accountId?.trim() || DEFAULT_TELEGRAM_ACCOUNT_ID,
        peer: outboundPeer(input),
        message: {
          text: input.text,
          attachments: input.attachments ?? attachmentRefsFromFiles(input.files),
          replyToMessageId: input.replyToMessageId,
          editMessageId: input.editMessageId,
        },
        metadata: input.metadata,
      },
      delivery: {
        ok: input.ok ?? !input.error,
        transportMessageId: input.transportMessageIds?.[0],
        error: input.error,
        raw: input.raw ?? (input.transportMessageIds?.length ? { transportMessageIds: input.transportMessageIds } : undefined),
      },
      metadata: input.metadata,
    });
    const updated = store.touchSession(session.sessionId, timestamp) ?? session;
    return { session: updated };
  } finally {
    store.close();
  }
}

export function recordTelegramInboundFromEnv(
  sessionId: string,
  env: Record<string, string | undefined> = process.env,
): RecordedTelegramTranscript | null {
  const chatId = env.BUTLER_INBOUND_CHAT_ID?.trim();
  const text = env.BUTLER_INBOUND_TEXT;
  if (!chatId || text === undefined) return null;
  const threadId = normalizeThreadId(env.BUTLER_INBOUND_THREAD_ID);
  return recordResolvedTelegramInbound({
    sessionId,
    chatId,
    threadId,
    peerKind: threadId ? "thread" : ((env.BUTLER_INBOUND_PEER_KIND as InboundEnvelope["peer"]["kind"] | undefined) ?? "group"),
    messageId: env.BUTLER_INBOUND_MESSAGE_ID,
    text,
    senderId: env.BUTLER_INBOUND_USER_ID,
    senderDisplayName: env.BUTLER_INBOUND_USER,
    timestamp: env.BUTLER_INBOUND_TIMESTAMP,
    projectId: env.BUTLER_INBOUND_PROJECT_ID,
    stewardId: env.BUTLER_INBOUND_STEWARD_ID,
    route: {
      source: env.BUTLER_INBOUND_ROUTE_SOURCE ?? "subsession-start",
      ...(env.BUTLER_INBOUND_PROJECT_ID ? { projectId: env.BUTLER_INBOUND_PROJECT_ID } : {}),
    },
    metadata: {
      source: env.BUTLER_INBOUND_METADATA_SOURCE ?? "session-transcript-cli",
    },
  });
}
