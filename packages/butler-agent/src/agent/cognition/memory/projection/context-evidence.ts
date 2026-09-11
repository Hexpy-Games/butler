import { createLazyConversationProjectionReader } from "../../../conversation/projection-reader-store.ts";
import type { ExtractInput } from "./contracts.ts";
import {
  assertCanonicalProjectionSourcesCurrent,
  hydrateSource,
} from "./source.ts";
import {
  expandSplitSourceLeaves,
  sourceRows,
  type openProjectionDb,
  type ProjectionSourceRow,
} from "./store.ts";

type QuoteSpan = {
  sourceId: string;
  byteStart: number;
  byteEnd: number;
  quote: string;
};
type Segment = { row: ProjectionSourceRow; start: number; end: number };
type ContextLayout = {
  text: Buffer;
  segments: Segment[];
  separators: number[];
};

/** Resolve pinned context excerpts without changing their model-facing handles or source coverage. */
export function createContextEvidenceResolver(
  db: ReturnType<typeof openProjectionDb>,
  sourceRoot: string,
  input: ExtractInput,
): (quote: QuoteSpan) => QuoteSpan[] {
  // Quote validation gives candidate excerpts precedence when a canonical ref is shared.
  const candidateRefs = new Set(
    input.candidates.flatMap((candidate) =>
      candidate.evidence.map((unit) => unit.ref),
    ),
  );
  const contexts = new Map(
    input.context_units
      .filter((unit) => !candidateRefs.has(unit.ref))
      .map((unit) => [unit.ref, unit]),
  );
  const layouts = new Map<string, ContextLayout>();
  const fail = (): never => {
    throw new Error("memory_source_changed");
  };

  function checkRows(rows: ProjectionSourceRow[]): void {
    if (!rows.length) fail();
    const current = db
      .query<
        { conversation_session_id: string | null },
        [string]
      >("SELECT conversation_session_id FROM memory_chunks WHERE memory_chunk_id=?")
      .get(input.episode_ref);
    for (const row of rows) {
      const chunk = db
        .query<
          { project_id: string | null; current_revision: string },
          [string]
        >("SELECT project_id,current_revision FROM memory_chunks WHERE memory_chunk_id=?")
        .get(row.episode_id);
      if (
        !chunk ||
        chunk.current_revision !== row.revision ||
        chunk.project_id !== input.bound_project_id ||
        !current?.conversation_session_id ||
        row.conversation_session_id !== current.conversation_session_id ||
        !["user_input", "assistant_public"].includes(row.origin_kind)
      )
        fail();
    }
    assertCanonicalProjectionSourcesCurrent(sourceRoot, db, rows);
  }

  function load(ref: string): ContextLayout {
    const cached = layouts.get(ref);
    if (cached) return cached;
    const unit = contexts.get(ref);
    if (!unit?.text) return fail();
    let segments: Segment[];
    const separators: number[] = [];
    if (ref.startsWith("conversation-message:")) {
      const reader = createLazyConversationProjectionReader({
        butlerData: sourceRoot,
      });
      let message;
      try {
        message = reader.readMessageById(
          ref.slice("conversation-message:".length),
        );
      } finally {
        reader.close();
      }
      if (
        !message ||
        !["complete", "compacted"].includes(message.status) ||
        !["user_input", "assistant_public"].includes(message.origin_kind ?? "")
      )
        return fail();
      // Match conversationMessageText exactly, retaining the original part positions.
      const parts = message.parts.flatMap((part) => {
        if (
          part.kind !== "text" ||
          !part.content_json ||
          typeof part.content_json !== "object" ||
          Array.isArray(part.content_json)
        )
          return [];
        const text = (part.content_json as Record<string, unknown>).text;
        return typeof text === "string" && text ? [{ id: part.id, text }] : [];
      });
      const joined = parts.map((part) => part.text).join(" ");
      const trimmed = joined.trim();
      if (!trimmed.endsWith(unit.text)) return fail();
      const base =
        Buffer.byteLength(joined) -
        Buffer.byteLength(joined.trimStart()) +
        Buffer.byteLength(trimmed) -
        Buffer.byteLength(unit.text);
      const rows = db
        .query<
          ProjectionSourceRow,
          [string]
        >("SELECT * FROM memory_chunk_sources WHERE conversation_message_id=? AND scalar_pointer='/text' ORDER BY part_id,byte_start")
        .all(message.id);
      checkRows(rows);
      let offset = 0;
      segments = [];
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index]!;
        for (const row of rows.filter((row) => row.part_id === part.id)) {
          segments.push({
            row,
            start: offset + row.byte_start - base,
            end: offset + row.byte_end - base,
          });
        }
        offset += Buffer.byteLength(part.text);
        if (index < parts.length - 1) {
          separators.push(offset - base);
          offset++;
        }
      }
    } else {
      const parent = sourceRows(db, [ref])[0];
      if (!parent) return fail();
      const original = hydrateSource(sourceRoot, parent).text;
      if (!original.endsWith(unit.text)) return fail();
      const base =
        parent.byte_start +
        Buffer.byteLength(original) -
        Buffer.byteLength(unit.text);
      const rows = sourceRows(db, expandSplitSourceLeaves(db, ref));
      checkRows(rows);
      segments = rows.map((row) => ({
        row,
        start: row.byte_start - base,
        end: row.byte_end - base,
      }));
    }
    const layout = { text: Buffer.from(unit.text), segments, separators };
    layouts.set(ref, layout);
    return layout;
  }

  return (quote) => {
    if (!contexts.has(quote.sourceId)) return [quote];
    const layout = load(quote.sourceId);
    if (
      quote.byteStart < 0 ||
      quote.byteEnd <= quote.byteStart ||
      quote.byteEnd > layout.text.length ||
      !layout.text
        .subarray(quote.byteStart, quote.byteEnd)
        .equals(Buffer.from(quote.quote))
    )
      return fail();
    const covered = new Uint8Array(quote.byteEnd - quote.byteStart);
    const resolved: QuoteSpan[] = [];
    for (const segment of layout.segments) {
      const start = Math.max(segment.start, quote.byteStart);
      const end = Math.min(segment.end, quote.byteEnd);
      if (start >= end) continue;
      if (
        covered
          .subarray(start - quote.byteStart, end - quote.byteStart)
          .some(Boolean)
      )
        return fail();
      covered.fill(1, start - quote.byteStart, end - quote.byteStart);
      const bytes = layout.text.subarray(start, end);
      const text = bytes.toString("utf8");
      if (!Buffer.from(text).equals(bytes)) return fail();
      resolved.push({
        sourceId: segment.row.source_id,
        byteStart: start - segment.start,
        byteEnd: end - segment.start,
        quote: text,
      });
    }
    for (const offset of layout.separators) {
      if (
        offset >= quote.byteStart &&
        offset < quote.byteEnd &&
        layout.text[offset] === 0x20
      )
        covered[offset - quote.byteStart] = 1;
    }
    if (!resolved.length || covered.some((byte) => byte === 0)) return fail();
    return resolved;
  };
}
