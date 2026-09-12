import { createLazyConversationProjectionReader } from "../../../conversation/projection-reader-store.ts";
import type { ExtractInput } from "./contracts.ts";
import {
  assertCanonicalProjectionSourcesCurrent,
  hydrateSource,
  projectionHash,
} from "./source.ts";
import {
  expandSplitSourceLeaves,
  sourceRows,
  type openProjectionDb,
  type ProjectionSourceRow,
} from "./store.ts";

import { sourcePassages, meaningPrompt } from "./meaning.ts";
import { graphemeByteBoundaries } from "./windows.ts";

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

/** Build bounded adjacent excerpts from the same immutable scalar, not earlier chat messages. */
export function attachAdjacentSourceContext(
  db: ReturnType<typeof openProjectionDb>, sourceRoot: string, input: ExtractInput, expansion: 0 | 1,
): ExtractInput {
  const original: ExtractInput = { ...input, context_units: input.context_units.filter((unit) => !unit.source_span) };
  const passages = sourcePassages(original);
  const sources = new Map(sourceRows(db, input.source_units.map((unit) => unit.ref)).map((row) => [row.source_id, row]));
  const hydrated = new Map([...sources].map(([ref, row]) => [ref, hydrateSource(sourceRoot, row)]));
  for (let width = expansion === 0 ? 64 : 128; width >= 0; width = width === 0 ? -1 : Math.floor(width / 2)) {
    const units: ExtractInput["context_units"] = [];
    for (const passage of passages) {
      const ref = passage.quote.unit_ref, row = sources.get(ref)!;
      const unit = input.source_units.find((value) => value.ref === ref)!;
      const scalar = hydrated.get(ref)?.scalar_text;
      if (!row || typeof scalar !== "string") throw new Error("memory_source_changed");
      let at = -1;
      for (let n = 0; n <= passage.quote.occurrence; n++) at = unit.text.indexOf(passage.text, at < 0 ? 0 : at + passage.text.length);
      if (at < 0) throw new Error("memory_source_changed");
      const focusStart = Buffer.byteLength(unit.text.slice(0, at)), focusEnd = focusStart + Buffer.byteLength(passage.text);
      const bounds = graphemeByteBoundaries(scalar);
      const first = bounds.indexOf(row.byte_start + focusStart), last = bounds.indexOf(row.byte_start + focusEnd);
      if (first < 0 || last < first) throw new Error("memory_source_changed");
      const allowance = Math.min(width, Math.floor((480 - (last - first)) / 2));
      const start = bounds[Math.max(0, first - allowance)]!, end = bounds[Math.min(bounds.length - 1, last + allowance)]!;
      if (start === row.byte_start + focusStart && end === row.byte_start + focusEnd) continue;
      const span = { source_ref: ref, byte_start: start, byte_end: end, focus_start: focusStart, focus_end: focusEnd, prefix_bytes: row.byte_start + focusStart - start };
      units.push({ ref: `memory-excerpt:${projectionHash([ref, input.revision, span]).slice(0, 48)}`, text: Buffer.from(scalar).subarray(start, end).toString(),
        observed_at: row.observed_at, basis: row.basis as ExtractInput["context_units"][number]["basis"], source_span: span });
    }
    const next: ExtractInput = { ...original, context_expansion: expansion, context_units: [...original.context_units, ...units] };
    try { meaningPrompt(next, sourcePassages(next)); return next; }
    catch (error) { if (!(error instanceof Error) || error.message !== "memory_extract_source_window_exceeds_budget" || width === 0) throw error; }
  }
  throw new Error("memory_extract_source_window_exceeds_budget");
}

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
    if (unit.source_span) {
      const span = unit.source_span;
      const anchor = sourceRows(db, [span.source_ref])[0];
      const current = input.source_units.find((entry) => entry.ref === span.source_ref);
      if (!anchor || !current || anchor.episode_id !== input.episode_ref || anchor.revision !== input.revision ||
        anchor.role !== current.role || span.focus_start < 0 || span.focus_end > Buffer.byteLength(current.text) ||
        span.focus_end <= span.focus_start || span.prefix_bytes !== anchor.byte_start + span.focus_start - span.byte_start ||
        span.prefix_bytes < 0 || span.byte_end < anchor.byte_start + span.focus_end ||
        ref !== `memory-excerpt:${projectionHash([span.source_ref, input.revision, span]).slice(0, 48)}`) return fail();
      const exact = hydrateSource(sourceRoot, { ...anchor, byte_start: span.byte_start, byte_end: span.byte_end });
      if (exact.text !== unit.text || unit.basis !== anchor.basis) return fail();
      const rows = db.query<ProjectionSourceRow, [string, string, string, string, string, number, number]>(`
        SELECT * FROM memory_chunk_sources WHERE episode_id=? AND revision=? AND part_id=? AND scalar_pointer=?
          AND conversation_message_id IS ? AND byte_end>? AND byte_start<? ORDER BY byte_start
      `).all(anchor.episode_id, anchor.revision, anchor.part_id, anchor.scalar_pointer, anchor.conversation_message_id, span.byte_start, span.byte_end);
      if (rows.some((row) => row.role !== anchor.role || row.content_hash !== anchor.content_hash || row.origin_kind !== anchor.origin_kind)) return fail();
      segments = rows.map((row) => ({ row, start: row.byte_start - span.byte_start, end: row.byte_end - span.byte_start }));
    } else if (ref.startsWith("conversation-message:")) {
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
