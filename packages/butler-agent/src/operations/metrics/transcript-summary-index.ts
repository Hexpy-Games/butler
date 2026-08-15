import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { scanJsonlFile } from "./jsonl-file-scanner.ts";

const INDEX_VERSION = 1;

export interface TranscriptSummaryIndex {
  version: 1;
  device: number;
  inode: number;
  byteLength: number;
  mtimeMs: number;
  events: number;
  conversationEvents: number;
  latestTimestamp: string | null;
  parseErrors: number;
  pendingTailBytes: number;
  pendingTailCounted: boolean;
  pendingTailEvents: number;
  pendingTailConversationEvents: number;
  pendingTailParseErrors: number;
  latestTimestampBeforeTail: string | null;
}

export interface TranscriptSummaryReadResult {
  exists: boolean;
  bytes: number;
  events: number;
  conversationEvents: number;
  latestTimestamp: string | null;
  parseErrors: number;
}

function safeFileName(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 32);
}

function indexPath(butlerData: string, transcriptPath: string): string {
  return join(butlerData, "metrics", "transcript-summary", `${safeFileName(transcriptPath)}.json`);
}

type FileStats = NonNullable<ReturnType<typeof statSync>>;

function emptyIndex(stat: FileStats): TranscriptSummaryIndex {
  return {
    version: INDEX_VERSION,
    device: Number(stat.dev),
    inode: Number(stat.ino),
    byteLength: 0,
    mtimeMs: Number(stat.mtimeMs),
    events: 0,
    conversationEvents: 0,
    latestTimestamp: null,
    parseErrors: 0,
    pendingTailBytes: 0,
    pendingTailCounted: false,
    pendingTailEvents: 0,
    pendingTailConversationEvents: 0,
    pendingTailParseErrors: 0,
    latestTimestampBeforeTail: null,
  };
}

function readIndex(path: string): TranscriptSummaryIndex | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TranscriptSummaryIndex>;
    if (
      parsed.version !== INDEX_VERSION ||
      typeof parsed.device !== "number" ||
      typeof parsed.inode !== "number" ||
      typeof parsed.byteLength !== "number" ||
      typeof parsed.mtimeMs !== "number" ||
      typeof parsed.events !== "number" ||
      typeof parsed.conversationEvents !== "number" ||
      (parsed.latestTimestamp !== null && typeof parsed.latestTimestamp !== "string") ||
      typeof parsed.parseErrors !== "number" ||
      typeof parsed.pendingTailBytes !== "number" ||
      typeof parsed.pendingTailCounted !== "boolean" ||
      typeof parsed.pendingTailEvents !== "number" ||
      typeof parsed.pendingTailConversationEvents !== "number" ||
      typeof parsed.pendingTailParseErrors !== "number" ||
      (parsed.latestTimestampBeforeTail !== null && typeof parsed.latestTimestampBeforeTail !== "string")
    ) {
      return null;
    }
    return {
      version: INDEX_VERSION,
      device: parsed.device,
      inode: parsed.inode,
      byteLength: Math.max(0, Math.trunc(parsed.byteLength)),
      mtimeMs: parsed.mtimeMs,
      events: Math.max(0, Math.trunc(parsed.events)),
      conversationEvents: Math.max(0, Math.trunc(parsed.conversationEvents)),
      latestTimestamp: parsed.latestTimestamp,
      parseErrors: Math.max(0, Math.trunc(parsed.parseErrors)),
      pendingTailBytes: Math.max(0, Math.trunc(parsed.pendingTailBytes)),
      pendingTailCounted: parsed.pendingTailCounted,
      pendingTailEvents: Math.max(0, Math.trunc(parsed.pendingTailEvents)),
      pendingTailConversationEvents: Math.max(0, Math.trunc(parsed.pendingTailConversationEvents)),
      pendingTailParseErrors: Math.max(0, Math.trunc(parsed.pendingTailParseErrors)),
      latestTimestampBeforeTail: parsed.latestTimestampBeforeTail,
    };
  } catch {
    return null;
  }
}

function writeIndex(path: string, index: TranscriptSummaryIndex): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(index)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // A diagnostic checkpoint must never make context monitoring fail.
  }
}

function parseTranscriptLine(line: string): {
  valid: boolean;
  conversation: boolean;
  timestamp: string | null;
} {
  if (!line.trim()) return { valid: true, conversation: false, timestamp: null };
  try {
    const parsed = JSON.parse(line) as {
      kind?: unknown;
      timestamp?: unknown;
    };
    if (!parsed || typeof parsed !== "object") {
      return { valid: false, conversation: false, timestamp: null };
    }
    return {
      valid: true,
      conversation: parsed.kind === "inbound" || parsed.kind === "outbound",
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : null,
    };
  } catch {
    return { valid: false, conversation: false, timestamp: null };
  }
}

function applyLine(index: TranscriptSummaryIndex, line: string): void {
  const parsed = parseTranscriptLine(line);
  if (!parsed.valid) {
    index.parseErrors += 1;
    return;
  }
  if (!line.trim()) return;
  index.events += 1;
  if (parsed.conversation) index.conversationEvents += 1;
  if (parsed.timestamp) index.latestTimestamp = parsed.timestamp;
}

function scanTranscript(
  path: string,
  index: TranscriptSummaryIndex,
  startOffset: number,
): TranscriptSummaryIndex {
  let beforeTail: string | null = null;
  let tailEvents = 0;
  let tailConversationEvents = 0;
  let tailParseErrors = 0;
  const result = scanJsonlFile(path, {
    startOffset,
    onLine: (line) => applyLine(index, line),
    onOversized: ({ complete }) => {
      // Oversized records are intentionally not materialized. Treat each one
      // as a derived-summary parse error so callers can distinguish a bounded
      // omission from a successful full record count.
      if (complete) index.parseErrors += 1;
    },
    onTrailing: (line) => {
      beforeTail = index.latestTimestamp;
      const beforeEvents = index.events;
      const beforeConversationEvents = index.conversationEvents;
      const beforeParseErrors = index.parseErrors;
      applyLine(index, line);
      tailConversationEvents = index.conversationEvents - beforeConversationEvents;
      tailParseErrors = index.parseErrors - beforeParseErrors;
      tailEvents = index.events - beforeEvents;
      // Keep this local count explicit so an appended newline can remove the
      // counted tail before the overlap is parsed again.
      if (index.events === beforeEvents) tailConversationEvents = 0;
    },
  });
  index.byteLength = startOffset + result.bytesRead;
  index.device = result.device;
  index.inode = result.inode;
  index.mtimeMs = result.mtimeMs;
  index.pendingTailBytes = result.trailingBytes;
  index.pendingTailCounted = result.trailingBytes > 0;
  index.pendingTailEvents = tailEvents;
  index.pendingTailConversationEvents = tailConversationEvents;
  index.pendingTailParseErrors = tailParseErrors;
  index.latestTimestampBeforeTail = beforeTail;
  return index;
}

export function readTranscriptSummaryIndex(input: {
  butlerData: string;
  transcriptPath: string;
}): TranscriptSummaryReadResult {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(input.transcriptPath);
  } catch {
    return {
      exists: false,
      bytes: 0,
      events: 0,
      conversationEvents: 0,
      latestTimestamp: null,
      parseErrors: 0,
    };
  }
  if (!stats.isFile()) {
    return {
      exists: false,
      bytes: 0,
      events: 0,
      conversationEvents: 0,
      latestTimestamp: null,
      parseErrors: 0,
    };
  }

  const path = indexPath(input.butlerData, input.transcriptPath);
  const previous = readIndex(path);
  const sameFile = previous && previous.device === Number(stats.dev) && previous.inode === Number(stats.ino);
  const reusable = sameFile && stats.size >= previous.byteLength;
  let next: TranscriptSummaryIndex;
  if (reusable && stats.size === previous.byteLength && stats.mtimeMs === previous.mtimeMs) {
    next = previous;
  } else if (reusable) {
    if (stats.size === previous.byteLength) {
      next = emptyIndex(stats);
      next = scanTranscript(input.transcriptPath, next, 0);
      writeIndex(path, next);
      return {
        exists: true,
        bytes: next.byteLength,
        events: next.events,
        conversationEvents: next.conversationEvents,
        latestTimestamp: next.latestTimestamp,
        parseErrors: next.parseErrors,
      };
    }
    next = {
      ...previous,
      device: Number(stats.dev),
      inode: Number(stats.ino),
      byteLength: previous.byteLength,
      mtimeMs: Number(stats.mtimeMs),
    };
    const start = Math.max(0, previous.byteLength - previous.pendingTailBytes);
    // The overlap contains only the previous incomplete JSON record. It was
    // counted for compatibility with final JSONL records without a newline;
    // remove that one bounded record before parsing the overlap again.
    if (previous.pendingTailCounted && previous.pendingTailBytes > 0) {
      if (previous.pendingTailConversationEvents > 0) {
        next.conversationEvents = Math.max(0, next.conversationEvents - previous.pendingTailConversationEvents);
      }
      if (previous.pendingTailParseErrors > 0) {
        next.parseErrors = Math.max(0, next.parseErrors - previous.pendingTailParseErrors);
      }
      next.events = Math.max(0, next.events - previous.pendingTailEvents);
      next.latestTimestamp = previous.latestTimestampBeforeTail;
    }
    next = scanTranscript(input.transcriptPath, next, start);
  } else {
    next = emptyIndex(stats);
    next = scanTranscript(input.transcriptPath, next, 0);
  }
  writeIndex(path, next);
  return {
    exists: true,
    bytes: next.byteLength,
    events: next.events,
    conversationEvents: next.conversationEvents,
    latestTimestamp: next.latestTimestamp,
    parseErrors: next.parseErrors,
  };
}
