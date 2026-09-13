import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { foldedGraphemeNgrams, unicodeCaseFold } from "./unicode.ts";

/** Rebuildable raw-text projection. It has no dependency on model output. */
export function ensureSourceIndexSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_source_text(
      id INTEGER PRIMARY KEY,
      source_id TEXT NOT NULL UNIQUE REFERENCES memory_chunk_sources(source_id),
      text TEXT NOT NULL, text_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_source_terms(
      term TEXT NOT NULL,
      source_key INTEGER NOT NULL REFERENCES memory_source_text(id),
      PRIMARY KEY(term,source_key)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_source_terms_source ON memory_source_terms(source_key);
  `);
}

/** Caller owns the same transaction as canonical source registration. */
export function indexMemorySourceText(db: Database, sourceId: string, text: string): void {
  const source = db.query<{ byte_start: number; byte_end: number }, [string]>(
    "SELECT byte_start,byte_end FROM memory_chunk_sources WHERE source_id=?",
  ).get(sourceId);
  if (!source || Buffer.byteLength(text) !== source.byte_end - source.byte_start) {
    throw new Error("memory_source_index_span_mismatch");
  }
  const textHash = createHash("sha256").update(text).digest("hex");
  const existing = db.query<{ text_hash: string }, [string]>(
    "SELECT text_hash FROM memory_source_text WHERE source_id=?",
  ).get(sourceId);
  if (existing) {
    if (existing.text_hash !== textHash) throw new Error("memory_source_index_changed");
    return;
  }
  const inserted = db.query("INSERT INTO memory_source_text(source_id,text,text_hash) VALUES(?,?,?)")
    .run(sourceId, text, textHash);
  const folded = unicodeCaseFold(text);
  const characters = [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(folded)]
    .map((item) => item.segment);
  const terms = new Set([...characters, ...foldedGraphemeNgrams(folded)]);
  const insert = db.query("INSERT INTO memory_source_terms(term,source_key) VALUES(?,?)");
  for (const term of terms) if (term.trim()) insert.run(term, inserted.lastInsertRowid);
}

export function sourceQueryTerms(phrases: string[]): string[] {
  const terms = new Set<string>();
  for (const phrase of phrases) {
    const folded = unicodeCaseFold(phrase.trim());
    const grams = foldedGraphemeNgrams(folded);
    for (const term of grams.length ? grams : [folded]) if (term.trim()) terms.add(term);
  }
  return [...terms];
}
