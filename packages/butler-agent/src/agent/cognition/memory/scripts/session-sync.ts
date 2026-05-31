// Incremental memory sync from Butler-owned transcripts.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir, tmpdir } from "os";
import { spawnSync } from "child_process";
import {
  buildIndexInputFromMessages,
  chunkConversationByGap,
  parseConversationLogLines,
  type ConversationMessage,
} from "./lib/conversation-sources.ts";
import { buildMemoryTranscriptPayload } from "./lib/ingestion.ts";
import { normalizeSessionIdForStorage } from "./lib/session-id.ts";
import { indexTranscriptLinesForQuery } from "../exact-query.ts";
import {
  findLocalLiveSessions,
  loadOffsets,
  saveOffsets,
  type SessionOffset,
} from "./lib/sessions.ts";
import { cognitionMemoryRoot } from "../../paths.ts";
import { butlerAgentSourcePath } from "../../../../runtime/paths.ts";

const BUTLER_HOME = process.env.BUTLER_HOME || process.cwd();
const BUTLER_DATA = process.env.BUTLER_DATA || join(homedir(), ".butler");
const MEMORY_DIR = cognitionMemoryRoot(BUTLER_DATA);
const OFFSET_FILE = join(MEMORY_DIR, "db", "session-sync-offset.json");
const DLQ_FILE = join(MEMORY_DIR, "queue", "dead-letter.jsonl");
const SAVE_HOT = butlerAgentSourcePath(BUTLER_HOME, "agent", "cognition", "memory", "scripts", "save_hot.ts");
const INDEX_TS = butlerAgentSourcePath(BUTLER_HOME, "agent", "cognition", "memory", "scripts", "index.ts");
const BUN = process.execPath;

function log(msg: string) {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  console.log(`[${ts}] ${msg}`);
}

export function appendSessionSyncDiagnostic(
  record: Record<string, unknown>,
  file: string = DLQ_FILE,
): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    ...record,
  })}\n`, "utf8");
}

export function parseMessages(lines: string[]): ConversationMessage[] {
  return parseConversationLogLines(lines).messages;
}

export function buildIndexInput(sourceLines: string[] | ConversationMessage[]): string {
  if (sourceLines.length === 0) return "";
  if (typeof sourceLines[0] === "string") {
    return (sourceLines as string[]).filter((line) => line.trim()).join("\n");
  }
  return buildIndexInputFromMessages(sourceLines as ConversationMessage[]);
}

export function chunkByGap(messages: ConversationMessage[]) {
  return chunkConversationByGap(messages);
}

export function prepareTempIndexInputPath(chunkId: string): string {
  const tmp = join(tmpdir(), `butler-session-sync-${normalizeSessionIdForStorage(chunkId)}.jsonl`);
  mkdirSync(dirname(tmp), { recursive: true });
  return tmp;
}

function readNewLines(path: string, offset?: SessionOffset): { lines: string[]; next: SessionOffset } {
  if (!existsSync(path)) {
    return {
      lines: [],
      next: {
        sessionId: offset?.sessionId ?? "",
        lastLine: offset?.lastLine ?? 0,
        byteOffset: offset?.byteOffset ?? 0,
      },
    };
  }
  const content = readFileSync(path, "utf8");
  const all = content.split("\n").filter((line) => line.trim());
  const lastLine = offset?.lastLine ?? 0;
  const lines = all.slice(lastLine);
  return {
    lines,
    next: {
      sessionId: offset?.sessionId ?? "",
      lastLine: all.length,
      byteOffset: Buffer.byteLength(content, "utf8"),
    },
  };
}

function syncTranscript(input: {
  path: string;
  sessionId: string;
  projectName: string;
  topic?: string;
  offset?: SessionOffset;
}): SessionOffset {
  const { lines, next } = readNewLines(input.path, {
    sessionId: input.sessionId,
    lastLine: input.offset?.lastLine ?? 0,
    byteOffset: input.offset?.byteOffset ?? 0,
  });
  next.sessionId = input.sessionId;
  if (lines.length === 0) return next;

  const messages = parseMessages(lines);
  indexTranscriptLinesForQuery({
    butlerData: BUTLER_DATA,
    lines,
    transcriptFile: input.path,
  });
  const payload = buildMemoryTranscriptPayload({
    lines,
    sourceSessionId: input.sessionId,
    chunkByGap: true,
  });
  const chunks = payload.chunks;
  if (payload.messageCount === 0) {
    appendSessionSyncDiagnostic({
      reason: "session_sync_unparseable_transcript",
      session_id: input.sessionId,
      project: input.projectName,
      line_count: lines.length,
    });
    log(`[${input.projectName}] skipped ${input.sessionId}: transcript had ${lines.length} new line(s) but no indexable conversation messages`);
    return next;
  }
  let saved = 0;

  chunks.forEach((chunk) => {
    const chunkId = chunk.sessionId.storage;
    const text = chunk.conversationText.slice(0, 8000);
    if (!text.trim()) return;

    const saveArgs = ["run", SAVE_HOT, "--project", input.projectName, "--session-id", chunkId, "--type", "conversation"];
    if (input.topic) saveArgs.push("--topic", input.topic);
    const save = spawnSync(BUN, saveArgs, { input: text, encoding: "utf8", timeout: 120000 });
    if (save.status === 0) saved++;

    if (existsSync(INDEX_TS)) {
      const tmp = prepareTempIndexInputPath(chunkId);
      writeFileSync(tmp, chunk.indexJsonl, "utf8");
      const index = spawnSync(BUN, [
        "run",
        INDEX_TS,
        "--file",
        tmp,
        "--project",
        input.projectName,
        "--session-id",
        chunkId,
        "--source-session-id",
        chunk.sessionId.original,
        "--strict",
      ], {
        encoding: "utf8",
        timeout: 120000,
      });
      if (index.status !== 0 || /WARNING:/.test(`${index.stdout}\n${index.stderr}`)) {
        const details = `${index.stderr || index.stdout || "unknown index failure"}`.trim();
        throw new Error(`session-sync index failed for ${chunkId}: ${details}`);
      }
    }
  });

  log(`[${input.projectName}] synced ${saved}/${chunks.length} chunk(s) from ${input.sessionId} (${messages.length} message(s))`);
  return next;
}

export async function runSessionSync() {
  mkdirSync(dirname(OFFSET_FILE), { recursive: true });
  const offsets = loadOffsets(OFFSET_FILE);
  const sessions = findLocalLiveSessions({ butlerData: BUTLER_DATA });
  if (sessions.length === 0) {
    log("No active Butler sessions found.");
    return;
  }

  for (const source of sessions) {
    const key = `${source.projectName}:${source.session.sessionId}`;
    offsets[key] = syncTranscript({
      path: source.path,
      sessionId: source.session.sessionId,
      projectName: source.projectName,
      topic: source.topic,
      offset: offsets[key],
    });
  }

  saveOffsets(offsets, OFFSET_FILE);
  log("session-sync complete");
}

if (import.meta.main) {
  await runSessionSync();
}
