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
  supportsProjectFilter?: boolean;
  embed(query: string, timeoutMs: number): Promise<number[] | null>;
  search(input: {
    dbPath: string;
    tableName: string;
    vector: number[];
    limit: number;
    fallbackLimit?: number;
    projectId?: string;
  }): Promise<VectorEpisodeSearchRows>;
}

export type VectorProjectFilterMode = "none" | "prefilter" | "postfilter";

export type VectorEpisodeSearchRows =
  | VectorEpisodeRow[]
  | {
    rows: VectorEpisodeRow[];
    projectFilterMode?: VectorProjectFilterMode;
    limit?: number;
  };

export interface VectorEpisodeSearchResult {
  candidates: RecallCandidate[];
  diagnostics: string[];
}

const VECTOR_SEARCH_MIN_LIMIT = 1;
const VECTOR_SEARCH_DEFAULT_LIMIT = 5;
const VECTOR_SEARCH_MAX_LIMIT = 10;
const VECTOR_SEARCH_MIN_TIMEOUT_MS = 200;
const VECTOR_SEARCH_DEFAULT_TIMEOUT_MS = 1_500;
const VECTOR_SEARCH_MAX_TIMEOUT_MS = 10_000;
const VECTOR_SEARCH_OVERFETCH_MULTIPLIER = 5;
const VECTOR_SEARCH_OVERFETCH_MAX_LIMIT = 50;
const VECTOR_CIRCUIT_FAILURE_THRESHOLD = 3;
const VECTOR_CIRCUIT_COOLDOWN_MS = 30_000;

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
  const limit = Math.max(
    VECTOR_SEARCH_MIN_LIMIT,
    Math.min(VECTOR_SEARCH_MAX_LIMIT, Math.trunc(input.limit ?? VECTOR_SEARCH_DEFAULT_LIMIT)),
  );
  const timeoutMs = Math.max(
    VECTOR_SEARCH_MIN_TIMEOUT_MS,
    Math.min(VECTOR_SEARCH_MAX_TIMEOUT_MS, Math.trunc(input.timeoutMs ?? VECTOR_SEARCH_DEFAULT_TIMEOUT_MS)),
  );
  const startedAt = Date.now();
  const dbPath = join(cognitionMemoryRoot(input.butlerData), "db", "butler.lance");
  const tableName = "butler_memory";
  const backend = input.backend ?? defaultVectorEpisodeBackend;
  const projectId = input.projectId?.trim() || undefined;
  if (!input.backend && !existsSync(dbPath)) {
    return { candidates: [], diagnostics: ["vector=unavailable:lancedb-missing"] };
  }
  const circuitState = vectorCircuitState(backend);
  if (circuitState.openUntil > Date.now()) {
    return {
      candidates: [],
      diagnostics: [
        "vector=unavailable:circuit-open",
        `vector_circuit_failures=${circuitState.failureCount}`,
      ],
    };
  }

  let vector: number[] | null;
  try {
    const embedResult = await withTimeout(
      () => backend.embed(query, timeoutMs),
      timeoutMs,
    );
    if (embedResult.status === "timeout") {
      recordVectorCircuitFailure(backend);
      return { candidates: [], diagnostics: ["vector=unavailable:embed-timeout"] };
    }
    vector = embedResult.value;
  } catch {
    recordVectorCircuitFailure(backend);
    return { candidates: [], diagnostics: ["vector=unavailable:embed-failed"] };
  }
  if (!vector || vector.length === 0) {
    recordVectorCircuitFailure(backend);
    return { candidates: [], diagnostics: ["vector=unavailable:embed-empty"] };
  }

  const remainingMs = remainingBudgetMs(startedAt, timeoutMs);
  if (remainingMs <= 0) {
    recordVectorCircuitFailure(backend);
    return { candidates: [], diagnostics: ["vector=unavailable:query-timeout"] };
  }
  const canPrefilterProject = Boolean(projectId && backend.supportsProjectFilter);
  const fallbackLimit = projectId ? overfetchLimit(limit) : limit;
  const searchLimit = canPrefilterProject ? limit : fallbackLimit;
  let rows: VectorEpisodeRow[];
  let actualProjectFilterMode: VectorProjectFilterMode = projectId
    ? (canPrefilterProject ? "prefilter" : "postfilter")
    : "none";
  let actualSearchLimit = searchLimit;
  try {
    const searchResult = await withTimeout(
      () => backend.search({
        dbPath,
        tableName,
        vector,
        limit: searchLimit,
        fallbackLimit,
        projectId: canPrefilterProject ? projectId : undefined,
      }),
      remainingMs,
    );
    if (searchResult.status === "timeout") {
      recordVectorCircuitFailure(backend);
      return { candidates: [], diagnostics: ["vector=unavailable:query-timeout"] };
    }
    const normalizedSearch = normalizeVectorSearchRows(searchResult.value);
    rows = normalizedSearch.rows;
    actualProjectFilterMode = normalizedSearch.projectFilterMode ?? actualProjectFilterMode;
    actualSearchLimit = normalizedSearch.limit ?? actualSearchLimit;
  } catch {
    recordVectorCircuitFailure(backend);
    return { candidates: [], diagnostics: ["vector=unavailable:query-failed"] };
  }
  recordVectorCircuitSuccess(backend);
  const filteredRows = projectId
    ? rows.filter((row) => row.project === projectId)
    : rows;
  const selectedRows = filteredRows.slice(0, limit);
  const candidates = vectorRowsToRecallCandidates(selectedRows);
  const rowsWithoutScore = selectedRows.filter((row) => vectorSimilarity(row) === undefined).length;
  return {
    candidates,
    diagnostics: [
      "vector=ok",
      `vector_rows=${rows.length}`,
      `vector_project_filter=${actualProjectFilterMode}`,
      `vector_search_limit=${actualSearchLimit}`,
      `vector_rows_without_score=${rowsWithoutScore}`,
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
    const similarity = vectorSimilarity(row);
    return [{
      id: `vector:${rowId}`,
      summary: compact(text, 180),
      text,
      source: "vector",
      provenance: [`vector:${sessionId}:${rowId}`],
      timestamp: typeof row.timestamp === "number" ? row.timestamp : undefined,
      frequency: 1,
      ...(similarity === undefined ? {} : { vectorSimilarity: similarity }),
    }];
  });
}

function vectorSimilarity(row: VectorEpisodeRow): number | undefined {
  if (typeof row._score === "number" && Number.isFinite(row._score)) {
    return clamp01(row._score);
  }
  if (typeof row._distance === "number" && Number.isFinite(row._distance)) {
    return clamp01(1 / (1 + Math.max(0, row._distance)));
  }
  return undefined;
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function createLanceDbMemoryVectorBackend(input?: {
  embed?: VectorEpisodeBackend["embed"];
}): VectorEpisodeBackend {
  return {
    supportsProjectFilter: true,
    async embed(query, timeoutMs) {
      if (input?.embed) return await input.embed(query, timeoutMs);
      return await embedViaSocket(query, undefined, timeoutMs);
    },
    async search(input) {
      const lancedb = await import("@lancedb/lancedb");
      const db = await lancedb.connect(input.dbPath);
      const table = await db.openTable(input.tableName);
      const search = table.search(input.vector) as LanceDbSearchBuilder;
      if (input.projectId && typeof search.where === "function") {
        const rows = await search
          .where(`project = ${lanceStringLiteral(input.projectId)}`)
          .limit(input.limit)
          .toArray() as VectorEpisodeRow[];
        return {
          rows,
          projectFilterMode: "prefilter",
          limit: input.limit,
        };
      }
      const fallbackLimit = input.fallbackLimit ?? input.limit;
      const rows = await search
        .limit(input.fallbackLimit ?? input.limit)
        .toArray() as VectorEpisodeRow[];
      return {
        rows,
        projectFilterMode: input.projectId ? "postfilter" : "none",
        limit: fallbackLimit,
      };
    },
  };
}

type LanceDbSearchBuilder = {
  where?: (clause: string) => LanceDbSearchBuilder;
  limit: (limit: number) => { toArray: () => Promise<unknown[]> };
};

type TimedResult<T> =
  | { status: "ok"; value: T }
  | { status: "timeout" };

const defaultVectorEpisodeBackend = createLanceDbMemoryVectorBackend();
const vectorCircuitStates = new WeakMap<VectorEpisodeBackend, {
  failureCount: number;
  openUntil: number;
}>();

function overfetchLimit(limit: number): number {
  return Math.max(limit, Math.min(VECTOR_SEARCH_OVERFETCH_MAX_LIMIT, limit * VECTOR_SEARCH_OVERFETCH_MULTIPLIER));
}

function normalizeVectorSearchRows(value: VectorEpisodeSearchRows): {
  rows: VectorEpisodeRow[];
  projectFilterMode?: VectorProjectFilterMode;
  limit?: number;
} {
  if (Array.isArray(value)) return { rows: value };
  return {
    rows: Array.isArray(value.rows) ? value.rows : [],
    projectFilterMode: value.projectFilterMode,
    limit: typeof value.limit === "number" && Number.isFinite(value.limit)
      ? value.limit
      : undefined,
  };
}

function remainingBudgetMs(startedAt: number, timeoutMs: number): number {
  return Math.max(0, timeoutMs - (Date.now() - startedAt));
}

function vectorCircuitState(backend: VectorEpisodeBackend): {
  failureCount: number;
  openUntil: number;
} {
  const state = vectorCircuitStates.get(backend);
  if (state) return state;
  const fresh = { failureCount: 0, openUntil: 0 };
  vectorCircuitStates.set(backend, fresh);
  return fresh;
}

function recordVectorCircuitSuccess(backend: VectorEpisodeBackend): void {
  const state = vectorCircuitState(backend);
  state.failureCount = 0;
  state.openUntil = 0;
}

function recordVectorCircuitFailure(backend: VectorEpisodeBackend): void {
  const state = vectorCircuitState(backend);
  state.failureCount += 1;
  if (state.failureCount >= VECTOR_CIRCUIT_FAILURE_THRESHOLD) {
    state.openUntil = Date.now() + VECTOR_CIRCUIT_COOLDOWN_MS;
  }
}

async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<TimedResult<T>> {
  if (timeoutMs <= 0) return { status: "timeout" };
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const running = Promise.resolve().then(operation);
  running.catch(() => undefined);
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const result = await Promise.race([running, timeout]);
    if (result === "timeout") {
      return { status: "timeout" };
    }
    return { status: "ok", value: result };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function lanceStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
