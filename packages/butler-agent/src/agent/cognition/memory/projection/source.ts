import { createHash } from "node:crypto";
import { createLazyConversationProjectionReader } from "../../../conversation/projection-reader-store.ts";
import { conversationMessageText } from "../../../conversation/message-text.ts";
import { AgentConversationStore } from "../../../conversation/store.ts";
import type {
  ConversationMessageWithParts,
  ConversationPart,
  ConversationProjectionReader,
} from "../../../conversation/types.ts";
import type { ExtractInput, ResolvedMemorySource } from "./contracts.ts";
import {
  MEMORY_SOURCE_WINDOW_BYTES,
  splitGraphemeUtf8Spans,
} from "./windows.ts";
import {
  sourceRows,
  type ProjectionSourceRow,
  openProjectionDb,
} from "./store.ts";
import { readTypedMemoryRecord } from "../quality.ts";

export function decodeMessageScalars(message: ConversationMessageWithParts) {
  return message.parts.flatMap((part) => decodePart(message, part));
}

export function memorySourceInventoryHash(value: {
  schema: string; origin?: { version?: string | null }; exclusions?: unknown;
  entries?: unknown[]; typed?: unknown[]; typed_lifecycle?: unknown[]; history?: unknown[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    schema: value.schema,
    origin_version: value.origin?.version ?? null,
    exclusions: value.exclusions ?? {},
    entries: value.entries ?? [],
    typed: value.typed ?? [],
    typed_lifecycle: value.typed_lifecycle ?? [],
    history: value.history ?? [],
  })).digest("hex");
}

function decodePart(
  message: ConversationMessageWithParts,
  part: ConversationPart,
): Array<{
  message: ConversationMessageWithParts;
  part: ConversationPart;
  pointer: string;
  text: string;
  hash: string;
}> {
  const values: Array<{ pointer: string; text: string }> = [];
  if (
    part.kind === "text" &&
    record(part.content_json) &&
    typeof part.content_json.text === "string"
  ) {
    values.push({ pointer: "/text", text: part.content_json.text });
  }
  if (part.kind === "message_content" && Array.isArray(part.content_json)) {
    part.content_json.forEach((item, index) => {
      if (record(item) && typeof item.text === "string")
        values.push({ pointer: `/${index}/text`, text: item.text });
    });
  }
  return values
    .filter((value) => value.text.length > 0)
    .map((value) => ({
      ...value,
      message,
      part,
      hash: createHash("sha256").update(value.text).digest("hex"),
    }));
}

function scalarForPart(part: ConversationPart, pointer: string): string | null {
  if (
    pointer === "/text" &&
    record(part.content_json) &&
    typeof part.content_json.text === "string"
  ) {
    return part.content_json.text;
  }
  const match = /^\/(\d+)\/text$/u.exec(pointer);
  if (match && Array.isArray(part.content_json)) {
    const value = part.content_json[Number(match[1])];
    return record(value) && typeof value.text === "string" ? value.text : null;
  }
  return null;
}

export function hydrateSource(
  butlerData: string,
  row: ProjectionSourceRow,
  maxChars = Number.POSITIVE_INFINITY,
): ResolvedMemorySource {
  if (row.source_kind === "task_report" || row.source_kind === "explicit_record")
    return hydrateTypedSource(butlerData, row, maxChars);
  const store = createLazyConversationProjectionReader({ butlerData });
  try {
    return hydrateSourceFromStore(store, row, maxChars);
  } finally {
    store.close();
  }
}

export function hydrateSources(
  butlerData: string,
  rows: ProjectionSourceRow[],
  maxGraphemes = Number.POSITIVE_INFINITY,
  deadlineAt = Number.POSITIVE_INFINITY,
  episodes: Array<{
    episodeId: string;
    revision: string;
    sessionId: string;
    turnId: string | null;
  }> = [],
): Map<string, { value?: ResolvedMemorySource; error?: "memory_source_changed" | "memory_source_deadline" }> {
  const output = new Map<string, { value?: ResolvedMemorySource; error?: "memory_source_changed" | "memory_source_deadline" }>();
  const store = createLazyConversationProjectionReader({ butlerData });
  const messageCache = new Map<string, ConversationMessageWithParts | null>();
  try {
    for (const row of rows) if (row.source_kind !== "conversation") {
      try { output.set(row.source_id, { value: hydrateTypedSource(butlerData, row, maxGraphemes) }); }
      catch { output.set(row.source_id, { error: "memory_source_changed" }); }
    }
    const conversationRows = rows.filter((row) => row.source_kind === "conversation");
    if (!store.isAvailable()) {
      for (const row of conversationRows) output.set(row.source_id, { error: "memory_source_changed" });
      return output;
    }
    const currentEpisodes = new Set(
      episodes
        .filter((episode) => episode.turnId && canonicalEpisodeRevisionMatches(store, messageCache, { ...episode, turnId: episode.turnId }))
        .map((episode) => `${episode.episodeId}\u0000${episode.revision}`),
    );
    const orderedRows = conversationRows.slice().sort((a, b) =>
      (a.conversation_message_id ?? "").localeCompare(b.conversation_message_id ?? "") ||
      a.part_id.localeCompare(b.part_id) ||
      a.scalar_pointer.localeCompare(b.scalar_pointer) ||
      a.byte_start - b.byte_start,
    );
    for (const row of orderedRows) {
      if (Date.now() >= deadlineAt) { output.set(row.source_id, { error: "memory_source_deadline" }); continue; }
      const episode = episodes.find((item) => item.episodeId === row.episode_id && item.revision === row.revision);
      const standaloneCurrent = episode?.turnId === null && canonicalStandaloneRevisionMatches(store, messageCache, row);
      if (episodes.length > 0 && !currentEpisodes.has(`${row.episode_id}\u0000${row.revision}`) && !standaloneCurrent) {
        output.set(row.source_id, { error: "memory_source_changed" });
        continue;
      }
      try {
        const message = cachedMessage(store, messageCache, row.conversation_message_id);
        output.set(row.source_id, { value: hydrateSourceFromMessage(message, row, maxGraphemes) });
      }
      catch { output.set(row.source_id, { error: "memory_source_changed" }); }
    }
  } finally { store.close(); }
  return output;
}

export function assertCanonicalProjectionSourcesCurrent(
  butlerData: string,
  db: ReturnType<typeof openProjectionDb>,
  rows: ProjectionSourceRow[],
): void {
  const conversationRows = rows.filter((row) => row.source_kind === "conversation");
  const episodes = [...new Set(conversationRows.map((row) => `${row.episode_id}\u0000${row.revision}`))].map((key) => {
    const [episodeId, revision] = key.split("\u0000") as [string, string];
    const chunk = db.query<{ conversation_session_id: string; conversation_turn_id: string | null; current_revision: string }, [string]>(
      "SELECT conversation_session_id,conversation_turn_id,current_revision FROM memory_chunks WHERE memory_chunk_id=?",
    ).get(episodeId);
    if (!chunk || chunk.current_revision !== revision) throw new Error("memory_source_changed");
    return { episodeId, revision, sessionId: chunk.conversation_session_id, turnId: chunk.conversation_turn_id };
  });
  const hydrated = hydrateSources(butlerData, rows, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, episodes);
  if (rows.some((row) => !hydrated.get(row.source_id)?.value)) throw new Error("memory_source_changed");
}

export function canonicalConversationProjectionInventory(input: {
  butlerData: string;
  canonicalDbPath?: string;
  asOf: string;
  deadlineAt: number;
  scope: "current_session" | "current_project" | "all_user_sessions";
  currentSessionId: string;
  currentProjectId: string | null;
  sessionIds: string[];
  projectFilter: "any" | "unassigned" | "selected";
  projectIds: string[];
  time?: { from: string; to: string; basis: "conversation" | "event" };
}): { entries: Array<{ episodeId: string; revision: string; sourceUnitCount: number; sourceIds: string[]; sourceHashes: string[]; originKinds: string[] }>; exclusions: Record<string, number>; partial: boolean; available: boolean } {
  const store = createLazyConversationProjectionReader({
    butlerData: input.butlerData,
    dbPath: input.canonicalDbPath,
  });
  const messageCache = new Map<string, ConversationMessageWithParts | null>();
  const sessionCache = new Map<string, ReturnType<ConversationProjectionReader["getSession"]>>();
  const entries: Array<{ episodeId: string; revision: string; sourceUnitCount: number; sourceIds: string[]; sourceHashes: string[]; originKinds: string[] }> = [];
  const exclusions: Record<string, number> = {};
  const exclude = (reason: string) => exclusions[reason] = (exclusions[reason] ?? 0) + 1;
  let after: string | null = null;
  let recoveredAfter: string | null = null;
  let partial = false;
  try {
    if (!store.isAvailable()) return { entries: [], exclusions: { canonical_reader_unavailable: 1 }, partial: true, available: false };
    const readRecoveredPage = (limit: number): number => {
      const messages = store.readRecoveredSourceMessages(recoveredAfter, limit);
      for (const message of messages) {
        if (Date.now() >= input.deadlineAt) { partial = true; break; }
        recoveredAfter = message.id;
        if (!sessionCache.has(message.session_id)) sessionCache.set(message.session_id, store.getSession(message.session_id));
        const session = sessionCache.get(message.session_id);
        if (!session || session.status === "deleted" || !sessionInInventoryScope(session.id, session.project_id, input) ||
          Date.parse(message.created_at) > Date.parse(input.asOf)) { exclude("scope_or_time"); continue; }
        if (input.time?.basis === "conversation" && (Date.parse(message.created_at) < Date.parse(input.time.from) || Date.parse(message.created_at) >= Date.parse(input.time.to))) continue;
        const scalars = decodeMessageScalars(message);
        if (!scalars.length) { exclude("source_text_missing"); continue; }
        const sourceHash = recoveredMessageSourceHash(message);
        const episodeId = projectionHash(["canonical-conversation-message", message.id]);
        const revision = projectionHash(["episode-revision", ...scalars.flatMap((scalar) => [scalar.message.id, scalar.part.id, scalar.pointer, scalar.hash]), sourceHash]);
        const sourceIds = inventorySourceIds(episodeId, revision, scalars);
        entries.push({
          episodeId, revision, sourceUnitCount: sourceIds.length, sourceIds,
          sourceHashes: [...new Set(scalars.map((scalar) => scalar.hash))].sort(),
          originKinds: [...new Set(scalars.map((scalar) => scalar.message.origin_kind ?? "unknown"))].sort(),
        });
      }
      return messages.length;
    };
    // Reserve an inventory page for no-turn recovered sources before historical
    // outcome pages can consume the operation deadline.
    readRecoveredPage(64);
    while (true) {
      if (Date.now() >= input.deadlineAt) { partial = true; break; }
      const outcomes = store.readTurnOutcomes(after, 500);
      if (outcomes.length === 0) break;
      for (const outcome of outcomes) {
        if (Date.now() >= input.deadlineAt) { partial = true; break; }
        after = outcome.id;
        if (!sessionCache.has(outcome.session_id)) sessionCache.set(outcome.session_id, store.getSession(outcome.session_id));
        const session = sessionCache.get(outcome.session_id);
        if (!session || session.status === "deleted" || !sessionInInventoryScope(session.id, session.project_id, input)) { exclude("scope_or_session"); continue; }
        const turn = store.readTurn(outcome.turn_id);
        if (!turn || turn.id !== outcome.turn_id || turn.session_id !== outcome.session_id ||
          !["complete", "failed", "aborted"].includes(turn.status)) {
          exclude("turn_not_terminal");
          continue;
        }
        const request = outcome.request_message_id ? cachedMessage(store, messageCache, outcome.request_message_id) : null;
        const assistant = outcome.public_assistant_message_id ? cachedMessage(store, messageCache, outcome.public_assistant_message_id) : null;
        if (!request || request.role !== "user" || !["complete", "compacted"].includes(request.status) || request.origin_kind !== "user_input") { exclude(request?.origin_kind === "unknown" ? "unknown_origin" : "request_ineligible"); continue; }
        if (outcome.public_assistant_message_id && (!assistant || assistant.role !== "assistant" || assistant.status !== "complete" || assistant.origin_kind !== "assistant_public")) { exclude(assistant?.origin_kind === "unknown" ? "unknown_origin" : "assistant_ineligible"); continue; }
        const messages = [request, ...(assistant ? [assistant] : [])];
        const observedMessages = messages.filter((message) => Date.parse(message.created_at) <= Date.parse(input.asOf));
        if (observedMessages.length === 0) continue;
        if (input.time?.basis === "conversation" && !observedMessages.some((message) =>
          Date.parse(message.created_at) >= Date.parse(input.time!.from) && Date.parse(message.created_at) < Date.parse(input.time!.to))) continue;
        const scalars = messages.flatMap(decodeMessageScalars);
        if (scalars.length === 0) { exclude("source_text_missing"); continue; }
        const episodeId = projectionHash(["canonical-conversation-turn", outcome.turn_id]);
        const revision = projectionHash([
          "episode-revision",
          ...scalars.flatMap((scalar) => [scalar.message.id, scalar.part.id, scalar.pointer, scalar.hash]),
          outcome.generation,
        ]);
        const sourceIds = inventorySourceIds(episodeId, revision, scalars);
        entries.push({
          episodeId, revision, sourceUnitCount: sourceIds.length, sourceIds,
          sourceHashes: [...new Set(scalars.map((scalar) => scalar.hash))].sort(),
          originKinds: [...new Set(scalars.map((scalar) => scalar.message.origin_kind ?? "unknown"))].sort(),
        });
      }
      if (partial || outcomes.length < 500) break;
    }
    while (!partial) {
      if (Date.now() >= input.deadlineAt) { partial = true; break; }
      if (readRecoveredPage(500) < 500) break;
    }
  } finally {
    store.close();
  }
  return { entries: entries.sort((a, b) => a.episodeId.localeCompare(b.episodeId)), exclusions, partial, available: true };
}

function inventorySourceIds(
  episodeId: string,
  revision: string,
  scalars: ReturnType<typeof decodeMessageScalars>,
): string[] {
  return scalars.flatMap((scalar) =>
    splitUtf8Spans(scalar.text, MEMORY_SOURCE_WINDOW_BYTES).map((span) => projectionHash([
      "memory-source", episodeId, revision, "conversation", scalar.message.id,
      scalar.part.id, scalar.pointer, span.start, span.end, scalar.hash,
    ]))).sort();
}

function sessionInInventoryScope(
  sessionId: string,
  projectId: string | null,
  input: Parameters<typeof canonicalConversationProjectionInventory>[0],
): boolean {
  if (input.scope === "current_session" && sessionId !== input.currentSessionId) return false;
  if (input.scope === "current_project" && projectId !== input.currentProjectId) return false;
  if (input.sessionIds.length > 0 && !input.sessionIds.includes(sessionId)) return false;
  if (input.projectFilter === "unassigned" && projectId !== null) return false;
  if (input.projectFilter === "selected" && !input.projectIds.includes(projectId ?? "")) return false;
  return true;
}

function canonicalEpisodeRevisionMatches(
  store: Pick<ConversationProjectionReader, "readTurn" | "readTurnOutcome" | "readMessageById">,
  messageCache: Map<string, ConversationMessageWithParts | null>,
  episode: { episodeId: string; revision: string; sessionId: string; turnId: string },
): boolean {
  const turn = store.readTurn(episode.turnId);
  const outcome = store.readTurnOutcome(episode.turnId);
  if (!turn || !outcome || turn.session_id !== episode.sessionId || outcome.session_id !== episode.sessionId ||
    !["complete", "failed", "aborted"].includes(turn.status)) return false;
  if (projectionHash(["canonical-conversation-turn", episode.turnId]) !== episode.episodeId) return false;
  const request = outcome.request_message_id
    ? cachedMessage(store, messageCache, outcome.request_message_id)
    : null;
  const assistant = outcome.public_assistant_message_id
    ? cachedMessage(store, messageCache, outcome.public_assistant_message_id)
    : null;
  if (!request || request.role !== "user" || !["complete", "compacted"].includes(request.status) ||
    request.origin_kind !== "user_input") return false;
  if (outcome.public_assistant_message_id && (!assistant || assistant.role !== "assistant" ||
    assistant.status !== "complete" || assistant.origin_kind !== "assistant_public")) return false;
  const scalars = [request, ...(assistant ? [assistant] : [])].flatMap(decodeMessageScalars);
  const revision = projectionHash([
    "episode-revision",
    ...scalars.flatMap((scalar) => [scalar.message.id, scalar.part.id, scalar.pointer, scalar.hash]),
    outcome.generation,
  ]);
  return revision === episode.revision;
}

function canonicalStandaloneRevisionMatches(
  store: Pick<ConversationProjectionReader, "readMessageById">,
  messageCache: Map<string, ConversationMessageWithParts | null>,
  row: ProjectionSourceRow,
): boolean {
  const message = cachedMessage(store, messageCache, row.conversation_message_id);
  if (!message || message.turn_id !== null || message.session_id !== row.conversation_session_id) return false;
  const eligible = message.role === "assistant"
    ? message.provenance === "recovered" && message.origin_kind === "assistant_public" && message.status === "complete"
    : message.role === "user" && message.origin_kind === "user_input" && ["recovered", "imported"].includes(message.provenance) && ["complete", "failed", "compacted"].includes(message.status);
  if (!eligible || projectionHash(["canonical-conversation-message", message.id]) !== row.episode_id) return false;
  const scalars = decodeMessageScalars(message);
  return projectionHash(["episode-revision", ...scalars.flatMap((scalar) => [scalar.message.id, scalar.part.id, scalar.pointer, scalar.hash]), recoveredMessageSourceHash(message)]) === row.revision;
}

function recoveredMessageSourceHash(message: ConversationMessageWithParts): string {
  return createHash("sha256").update(JSON.stringify(message.parts.map((part) => [part.id, part.content_json]))).digest("hex");
}

function cachedMessage(
  store: Pick<ConversationProjectionReader, "readMessageById">,
  cache: Map<string, ConversationMessageWithParts | null>,
  messageId: string,
): ConversationMessageWithParts | null {
  if (!cache.has(messageId)) cache.set(messageId, store.readMessageById(messageId));
  return cache.get(messageId) ?? null;
}

function hydrateSourceFromStore(
  store: Pick<ConversationProjectionReader, "readMessageById">,
  row: ProjectionSourceRow,
  maxGraphemes: number,
): ResolvedMemorySource {
  if (!row.conversation_message_id) throw new Error("memory_source_changed");
  const message = store.readMessageById(row.conversation_message_id);
  return hydrateSourceFromMessage(message, row, maxGraphemes);
}

function hydrateSourceFromMessage(
  message: ConversationMessageWithParts | null,
  row: ProjectionSourceRow,
  maxGraphemes: number,
): ResolvedMemorySource {
  const part = message?.parts.find((item) => item.id === row.part_id);
  const scalar = part ? scalarForPart(part, row.scalar_pointer) : null;
  if (!message || !scalar || message.session_id !== row.conversation_session_id || message.role !== row.role ||
    message.origin_kind !== row.origin_kind || !["complete", "failed", "compacted"].includes(message.status) ||
    createHash("sha256").update(scalar).digest("hex") !== row.content_hash)
    throw new Error("memory_source_changed");
  const bytes = Buffer.from(scalar, "utf8");
  if (row.byte_start < 0 || row.byte_end <= row.byte_start || row.byte_end > bytes.length) throw new Error("memory_source_changed");
  const slice = bytes.subarray(row.byte_start, row.byte_end);
  const text = slice.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(slice)) throw new Error("memory_source_changed");
  return {
    source_ref: row.source_id,
    source_kind: "conversation",
    text,
    excerpt: truncateGraphemes(text, maxGraphemes),
    byte_start: row.byte_start,
    byte_end: row.byte_end,
    source_hash: row.content_hash,
    conversation_session_id: row.conversation_session_id,
    conversation_message_id: row.conversation_message_id,
    basis: row.basis as ResolvedMemorySource["basis"],
    origin_kind: row.origin_kind as ResolvedMemorySource["origin_kind"],
    scalar_text: scalar,
  };
}

function hydrateTypedSource(
  butlerData: string,
  row: ProjectionSourceRow,
  maxGraphemes: number,
): ResolvedMemorySource {
  if (row.source_kind !== "task_report" && row.source_kind !== "explicit_record")
    throw new Error("memory_source_changed");
  const owner = readTypedMemoryRecord(
    butlerData,
    row.source_kind,
    row.part_id,
    { unavailable: "throw" },
  );
  if (!owner || owner.revision !== row.revision || owner.content_hash !== row.content_hash ||
    owner.conversation_session_id !== row.conversation_session_id || owner.role !== row.role ||
    owner.basis !== row.basis) throw new Error("memory_source_changed");
  const bytes = Buffer.from(owner.text, "utf8");
  if (row.byte_start < 0 || row.byte_end <= row.byte_start || row.byte_end > bytes.length)
    throw new Error("memory_source_changed");
  const slice = bytes.subarray(row.byte_start, row.byte_end);
  const text = slice.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(slice)) throw new Error("memory_source_changed");
  return {
    source_ref: row.source_id,
    source_kind: row.source_kind,
    text,
    excerpt: truncateGraphemes(text, maxGraphemes),
    byte_start: row.byte_start,
    byte_end: row.byte_end,
    source_hash: row.content_hash,
    conversation_session_id: row.conversation_session_id,
    conversation_message_id: owner.conversation_message_id,
    project_id: owner.project_id,
    basis: owner.basis,
    origin_kind: "unknown",
    scalar_text: owner.text,
  };
}

function truncateGraphemes(value: string, limit: number): string {
  if (!Number.isFinite(limit)) return value;
  return [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(value)]
    .slice(0, Math.max(0, Math.trunc(limit))).map((part) => part.segment).join("");
}

export function splitUtf8Spans(
  text: string,
  maxBytes: number,
): Array<{ start: number; end: number }> {
  // Canonical source IDs are stable across extractor upgrades. Model-sized
  // partitions belong to the window lineage, not the source inventory.
  return splitGraphemeUtf8Spans(text, maxBytes).map(({ start, end }) => ({ start, end }));
}

export function packWindows(
  refs: string[],
  db: ReturnType<typeof openProjectionDb>,
  maxBytes: number,
): string[][] {
  const rows = sourceRows(db, refs);
  // A source span is already bounded and has one speaker. Never merge it back
  // into a larger mixed-speaker extraction window.
  if (rows.length !== refs.length) throw new Error("memory_source_changed");
  for (const row of rows) {
    if (row.byte_end - row.byte_start > maxBytes) throw new Error("memory_extract_source_window_exceeds_budget");
  }
  return refs.map((ref) => [ref]);
}

export function combinedOrigin(
  messages: ConversationMessageWithParts[],
): string {
  if (messages.some((message) => message.origin_kind === "internal_control"))
    return "internal_control";
  if (
    messages.some(
      (message) => !message.origin_kind || message.origin_kind === "unknown",
    )
  )
    return "unknown";
  return "user_input";
}

export function readPriorPublicContext(
  butlerData: string,
  sessionId: string,
  sourceUnits: ExtractInput["source_units"],
): ExtractInput["context_units"] {
  if (!sessionId) return [];
  const firstObservedAt =
    sourceUnits.map((unit) => unit.observed_at).sort()[0] ?? "";
  const store = createLazyConversationProjectionReader({ butlerData });
  try {
    if (!store.isAvailable()) throw new Error("memory_source_changed");
    return store
      .readProjectionMessages(sessionId, { limit: 500 })
      .filter((message) => message.created_at < firstObservedAt)
      .filter(
        (message) =>
          message.status === "complete" || message.status === "compacted",
      )
      .filter(
        (message) =>
          message.origin_kind === "user_input" ||
          message.origin_kind === "assistant_public",
      )
      .filter(
        (message) => message.role === "user" || message.role === "assistant",
      )
      .slice(-2)
      .map((message) => ({
        ref: `conversation-message:${message.id}`,
        text: tailGraphemesWithinBytes(conversationMessageText(message), 4 * 1024),
        observed_at: message.created_at,
        basis:
          message.role === "user"
            ? ("user_statement" as const)
            : ("assistant_statement" as const),
      }))
      .filter((unit) => unit.text.length > 0)
      .reduceRight<ExtractInput["context_units"]>((kept, unit) => {
        const candidate = [unit, ...kept];
        return Buffer.byteLength(JSON.stringify(candidate)) <= 4 * 1024 ? candidate : kept;
      }, []);
  } finally {
    store.close();
  }
}

function tailGraphemesWithinBytes(value: string, maxBytes: number): string {
  const segments = [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(value)].map((item) => item.segment);
  let output = "";
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const next = segments[index]! + output;
    if (Buffer.byteLength(next) > maxBytes) break;
    output = next;
  }
  return output;
}

export function projectionHash(values: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
