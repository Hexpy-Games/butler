import type { TranscriptExportStream } from "../../interface/protocol/app-protocol.ts";
import {
  MAX_SESSION_MESSAGE_PAGE_SIZE,
  type SessionMessagePageOptions,
  type TranscriptMessagePage,
} from "./session-message-page.ts";

const TRANSCRIPT_EXPORT_TEXT_CHUNK_SIZE = 64 * 1024;

export function createTranscriptExportStream(input: {
  sessionId: string;
  title: string;
  kind: string;
  generatedAt: string;
  listPage: (
    sessionId: string,
    options?: SessionMessagePageOptions,
  ) => TranscriptMessagePage;
}): TranscriptExportStream {
  return {
    session_id: input.sessionId,
    format: "markdown",
    filename: `${safeExportFilename(input.title)}.md`,
    generated_at: input.generatedAt,
    chunks: transcriptChunks(input),
  };
}

function* transcriptChunks(input: {
  sessionId: string;
  title: string;
  kind: string;
  generatedAt: string;
  listPage: (
    sessionId: string,
    options?: SessionMessagePageOptions,
  ) => TranscriptMessagePage;
}): Iterable<{ text: string; message_count?: number }> {
  yield {
    text: `# ${input.title}\n\nSession: ${input.kind}\nGenerated: ${input.generatedAt}\n\n`,
  };
  let afterCursor = 0;
  let pageCount = 0;
  while (pageCount < 100_000) {
    const page = input.listPage(input.sessionId, {
      fromBeginning: pageCount === 0,
      ...(pageCount > 0 ? { afterCursor } : {}),
      limit: MAX_SESSION_MESSAGE_PAGE_SIZE,
    });
    if (page.items.length === 0) break;
    yield* formatPage(page);
    const nextCursor = Number(page.nextCursor ?? 0);
    if (!page.hasMore || nextCursor <= afterCursor) break;
    afterCursor = nextCursor;
    pageCount += 1;
  }
}

function* formatPage(
  page: TranscriptMessagePage,
): Iterable<{ text: string; message_count?: number }> {
  const pending: string[] = [];
  let pendingLength = 0;
  let pendingMessageCount = 0;
  const append = (text: string, completeMessage = false): void => {
    pending.push(text);
    pendingLength += text.length;
    if (completeMessage) pendingMessageCount += 1;
  };
  for (const message of page.items) {
    if (
      message.role !== "user" &&
      message.role !== "assistant" &&
      message.role !== "automation" &&
      message.role !== "system_event"
    ) {
      continue;
    }
    append(`## ${message.role}\n\n`);
    for (let offset = 0; offset < message.text.length; offset += TRANSCRIPT_EXPORT_TEXT_CHUNK_SIZE) {
      append(message.text.slice(offset, offset + TRANSCRIPT_EXPORT_TEXT_CHUNK_SIZE));
    }
    append("\n\n", true);
    if (pendingLength >= TRANSCRIPT_EXPORT_TEXT_CHUNK_SIZE) {
      yield {
        text: pending.join(""),
        ...(pendingMessageCount > 0 ? { message_count: pendingMessageCount } : {}),
      };
      pending.length = 0;
      pendingLength = 0;
      pendingMessageCount = 0;
    }
  }
  if (pending.length > 0) {
    yield {
      text: pending.join(""),
      ...(pendingMessageCount > 0 ? { message_count: pendingMessageCount } : {}),
    };
  }
}

function safeExportFilename(title: string): string {
  const sanitized = title
    .replace(/[\\/:*?"<>|]/gu, "-")
    .split("")
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? "-" : character;
    })
    .join("");
  return sanitized
    .trim()
    .slice(0, 120) || "session";
}
