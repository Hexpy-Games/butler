import { existsSync } from "fs";
import { join } from "path";
import { cognitionMemoryRoot } from "../../paths.ts";
import { embedViaSocket } from "../scripts/embed.ts";
import type { RecallCandidate } from "./engine.ts";

export interface VectorEpisodeRow {
  id?: string;
  text?: string;
  project?: string;
  type?: string;
  session_id?: string;
  timestamp?: number;
  source?: string;
  topic?: string;
  _distance?: number;
  _score?: number;
}

export interface VectorEpisodeBackend {
  embed(query: string, timeoutMs: number): Promise<number[] | null>;
  search(input: {
    dbPath: string;
    tableName: string;
    vector: number[];
    limit: number;
  }): Promise<VectorEpisodeRow[]>;
}

export interface VectorEpisodeSearchResult {
  candidates: RecallCandidate[];
  diagnostics: string[];
}

export async function searchVectorEpisodes(input: {
  butlerData: string;
  query: string;
  projectId?: string;
  limit?: number;
  timeoutMs?: number;
  backend?: VectorEpisodeBackend;
}): Promise<VectorEpisodeSearchResult> {
  const query = input.query.trim();
  if (!query) {
    return { candidates: [], diagnostics: ["vector=skipped:empty-query"] };
  }
  const limit = Math.max(1, Math.min(10, Math.trunc(input.limit ?? 5)));
  const timeoutMs = Math.max(200, Math.min(10_000, Math.trunc(input.timeoutMs ?? 1500)));
  const dbPath = join(cognitionMemoryRoot(input.butlerData), "db", "butler.lance");
  const tableName = "butler_memory";
  const backend = input.backend ?? defaultVectorEpisodeBackend;
  if (!input.backend && !existsSync(dbPath)) {
    return { candidates: [], diagnostics: ["vector=unavailable:lancedb-missing"] };
  }

  let vector: number[] | null;
  try {
    vector = await backend.embed(query, timeoutMs);
  } catch {
    return { candidates: [], diagnostics: ["vector=unavailable:embed-failed"] };
  }
  if (!vector || vector.length === 0) {
    return { candidates: [], diagnostics: ["vector=unavailable:embed-empty"] };
  }

  let rows: VectorEpisodeRow[];
  try {
    rows = await backend.search({ dbPath, tableName, vector, limit });
  } catch {
    return { candidates: [], diagnostics: ["vector=unavailable:query-failed"] };
  }
  const filteredRows = input.projectId?.trim()
    ? rows.filter((row) => row.project === input.projectId)
    : rows;
  const candidates = vectorRowsToRecallCandidates(filteredRows.slice(0, limit));
  return {
    candidates,
    diagnostics: [
      "vector=ok",
      `vector_rows=${rows.length}`,
      `vector_candidates=${candidates.length}`,
    ],
  };
}

export function vectorRowsToRecallCandidates(
  rows: VectorEpisodeRow[],
): RecallCandidate[] {
  return rows.flatMap((row, index) => {
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (!text) return [];
    const rowId = typeof row.id === "string" && row.id.trim()
      ? row.id.trim()
      : `row_${index + 1}`;
    const sessionId = typeof row.session_id === "string" && row.session_id.trim()
      ? row.session_id.trim()
      : "unknown-session";
    return [{
      id: `vector:${rowId}`,
      summary: compact(text, 180),
      text,
      source: "vector",
      provenance: [`vector:${sessionId}:${rowId}`],
      timestamp: typeof row.timestamp === "number" ? row.timestamp : undefined,
      frequency: 1,
      vectorSimilarity: vectorSimilarity(row),
    }];
  });
}

function vectorSimilarity(row: VectorEpisodeRow): number {
  if (typeof row._score === "number" && Number.isFinite(row._score)) {
    return clamp01(row._score);
  }
  if (typeof row._distance === "number" && Number.isFinite(row._distance)) {
    return clamp01(1 / (1 + Math.max(0, row._distance)));
  }
  return 1;
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

const defaultVectorEpisodeBackend: VectorEpisodeBackend = {
  async embed(query, timeoutMs) {
    return await embedViaSocket(query, undefined, timeoutMs);
  },
  async search(input) {
    const lancedb = await import("@lancedb/lancedb");
    const db = await lancedb.connect(input.dbPath);
    const table = await db.openTable(input.tableName);
    return await table.search(input.vector).limit(input.limit).toArray() as VectorEpisodeRow[];
  },
};
