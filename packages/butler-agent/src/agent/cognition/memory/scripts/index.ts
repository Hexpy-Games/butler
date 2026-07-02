// CLI: bun run index.ts --file <path> --project <name> --session-id <id> --type summary [--plain-text]
import * as lancedb from "@lancedb/lancedb";
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, renameSync } from "fs";
import { dirname, join } from "path";
import { embed, embedBatch } from "./embed.ts";
import { extractAndSave } from "./extract.ts";
import { BUTLER_DIR } from "./constants.ts";

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

// Extract plain text from JSONL conversation envelope.
// Only user/assistant messages with text blocks are included.
// tool_use and tool_result blocks are skipped (retrieval noise + large tokens).
export function extractTextFromJsonl(jsonl: string): string {
  const lines: string[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: any;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    const type = obj?.type;
    if (type !== "user" && type !== "assistant") continue;
    const msg = obj?.message;
    if (!msg) continue;
    const content = msg.content;
    if (typeof content === "string") {
      if (content.trim()) lines.push(content.trim());
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          lines.push(block.text.trim());
        }
      }
    }
  }
  return lines.join("\n\n");
}

export function extractSourceMessageIdsFromJsonl(jsonl: string): string[] {
  const ids: string[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: any;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (!Array.isArray(obj?.source_message_ids)) continue;
    for (const id of obj.source_message_ids) {
      if (typeof id === "string" && id.trim()) ids.push(id.trim());
    }
  }
  return [...new Set(ids)];
}

// Chunk by ~2000 chars (~500 tokens for mixed Korean/English) with 50-char overlap.
export function chunkText(text: string, size = 2000, overlap = 50): string[] {
  if (!text.trim()) return [];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + size));
    i += size - overlap;
  }
  return chunks;
}

if (import.meta.main) {
  const DB_PATH = join(BUTLER_DIR.MEMORY, "db", "butler.lance");
  const LOG_FILE = join(BUTLER_DIR.LOGS, "memory.log");

  const args = process.argv.slice(2);
  const file = getArg(args, "--file");
  const project = getArg(args, "--project") ?? "unknown";
  const sessionId = getArg(args, "--session-id") ?? Date.now().toString();
  const sourceSessionId = getArg(args, "--source-session-id") ?? sessionId;
  const type = getArg(args, "--type") ?? "conversation";
  const source = getArg(args, "--source") ?? "butler";
  const topic = getArg(args, "--topic");
  const strict = args.includes("--strict");
  const plainText = args.includes("--plain-text");

  if (!file) { console.error("--file required"); process.exit(1); }

  const raw = readFileSync(file, "utf8");
  const now = Math.floor(Date.now() / 1000);

  const text = plainText ? raw.trim() : extractTextFromJsonl(raw);
  const sourceMessageIds = plainText ? [] : extractSourceMessageIdsFromJsonl(raw);
  const chunks = chunkText(text);

  if (chunks.length === 0) {
    // Distinguish "empty input" (legit, exit 0) from "non-empty input that
    // produced zero parseable JSONL messages" (format contract violation,
    // exit non-zero). The April 2025 incident was a silent exit 0 here.
    if (raw.trim().length === 0) {
      console.log("Empty input (skipping)");
      process.exit(0);
    }
    if (plainText) {
      console.log("Empty plain-text input (skipping)");
      process.exit(0);
    }
    // Is any line valid JSONL at all? If zero lines parse, reject loudly.
    const lines = raw.split("\n").filter(l => l.trim());
    let parseable = 0;
    for (const line of lines) {
      try { JSON.parse(line); parseable++; } catch {}
    }
    if (parseable === 0) {
      console.error(`ERROR: input is non-empty (${raw.length} bytes, ${lines.length} lines) but contains no parseable JSONL. Expected: one JSON object per line. Producer contract broken.`);
      process.exit(2);
    }
    // Valid JSONL but no user/assistant text (e.g. pure tool traffic) — legit 0-exit.
    console.log(`No user/assistant text to index (${parseable} JSONL lines, none contained text content)`);
    process.exit(0);
  }

  const batchResult = await embedBatch(chunks);
  if (batchResult.some(v => v === null)) {
    console.error("WARNING: embed-server not running — skipping indexing");
    process.exit(strict ? 3 : 0);
  }
  const vectors = batchResult as number[][];

  const db = await lancedb.connect(DB_PATH);

  // Open existing table or create fresh
  let table;
  try {
    table = await db.openTable("butler_memory");
  } catch {
    const sampleVector = await embed("init");
    if (!sampleVector) {
      console.error("WARNING: embed-server not running — cannot create table");
      process.exit(strict ? 3 : 0);
    }
    table = await db.createTable("butler_memory", [{
      id: "__init__",
      text: "",
      project: "",
      type: "",
      session_id: "",
      timestamp: 0,
      hot_score: 0,
      source: "",
      topic: "",
      vector: sampleVector,
    }]);
    await table.delete("id = '__init__'");
  }

  const rows = chunks.map((chunk, i) => ({
    id: `${sessionId}_${i}`,
    text: chunk,
    project,
    type,
    session_id: sessionId,
    timestamp: now,
    hot_score: 0,
    source,
    topic: topic ?? "",
    vector: vectors[i],
  }));

  // Validate sessionId to prevent SQL injection
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("invalid session id");

  // Upsert: delete existing rows for this session_id, then add fresh
  await table.delete(`session_id = '${sessionId}'`);
  await table.add(rows);

  console.log(`Indexed ${chunks.length} chunks into LanceDB`);

  // Extract entities and relationships into the graph layer
  try {
    extractAndSave(text, sessionId, project, source);
  } catch (err: any) {
    process.stderr.write(`Warning: graph extraction failed (${err.message})\n`);
    if (strict) process.exit(4);
  }

  const indexedAt = new Date().toISOString();
  const provenancePath = join(BUTLER_DIR.MEMORY, "db", "session-provenance.jsonl");
  mkdirSync(dirname(provenancePath), { recursive: true });
  appendFileSync(provenancePath, `${JSON.stringify({
    session_id: sessionId,
    source_session_id: sourceSessionId,
    project,
    source,
    topic: topic ?? null,
    source_message_ids: sourceMessageIds,
    indexed_at: indexedAt,
    chunk_count: chunks.length,
  })}\n`, "utf8");

  const vectorRowCount = await table.countRows();
  writeJsonAtomic(join(BUTLER_DIR.MEMORY, "db", "vector-stats.json"), {
    table: "butler_memory",
    row_count: vectorRowCount,
    updated_at: indexedAt,
    last_session_id: sessionId,
    last_source_session_id: sourceSessionId,
    last_source_message_ids: sourceMessageIds,
    last_chunk_count: chunks.length,
  });

  const logEntry = `[${new Date().toISOString().slice(0, 19).replace("T", " ")}] index.ts | project=${project} session=${sessionId} | chunks=${chunks.length}\n`;
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  appendFileSync(LOG_FILE, logEntry);
  process.exit(0);
}
