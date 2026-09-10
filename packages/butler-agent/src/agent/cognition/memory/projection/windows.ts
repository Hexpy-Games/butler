import type { ExtractInput } from "./contracts.ts";

export const MEMORY_SOURCE_WINDOW_BYTES = 8 * 1024;
export const MEMORY_CONTEXT_BYTES = 4 * 1024;
export const MEMORY_CANDIDATE_BYTES = 8 * 1024;
export const MEMORY_EXTRACT_INPUT_BYTES = 24 * 1024;
export const MEMORY_SPLIT_MIN_SOURCE_BYTES = 512;

export function graphemeByteBoundaries(text: string): number[] {
  const boundaries = [0];
  let byte = 0;
  for (const part of new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text)) {
    byte += Buffer.byteLength(part.segment);
    boundaries.push(byte);
  }
  return boundaries;
}

export function splitGraphemeUtf8Spans(
  text: string,
  maxBytes = MEMORY_SOURCE_WINDOW_BYTES,
): Array<{ start: number; end: number; oversized: boolean }> {
  const boundaries = graphemeByteBoundaries(text);
  const spans: Array<{ start: number; end: number; oversized: boolean }> = [];
  let start = 0;
  for (let index = 1; index < boundaries.length; index += 1) {
    const end = boundaries[index]!;
    if (end - start > maxBytes) {
      const prior = boundaries[index - 1]!;
      if (prior > start) spans.push({ start, end: prior, oversized: false });
      spans.push({ start: prior, end, oversized: end - prior > maxBytes });
      start = end;
    }
  }
  const end = boundaries.at(-1) ?? 0;
  if (end > start) spans.push({ start, end, oversized: false });
  return spans;
}

export function nearestGraphemeByteMidpoint(
  parts: Array<{ text: string; bytes: number }>,
): { partIndex: number; localByte: number } | null {
  const total = parts.reduce((sum, part) => sum + part.bytes, 0);
  if (total < MEMORY_SPLIT_MIN_SOURCE_BYTES * 2) return null;
  let cumulative = 0;
  let best: { partIndex: number; localByte: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const part = parts[partIndex]!;
    for (const localByte of graphemeByteBoundaries(part.text).slice(1)) {
      const left = cumulative + localByte;
      const right = total - left;
      if (left < MEMORY_SPLIT_MIN_SOURCE_BYTES || right < MEMORY_SPLIT_MIN_SOURCE_BYTES) continue;
      if (localByte === part.bytes && partIndex === parts.length - 1) continue;
      const distance = Math.abs(left - total / 2);
      if (distance < bestDistance) {
        best = { partIndex, localByte };
        bestDistance = distance;
      }
    }
    cumulative += part.bytes;
  }
  return best;
}

export function enforceExtractInputBudget(input: ExtractInput): ExtractInput {
  while (jsonBytes(input.context_units) > MEMORY_CONTEXT_BYTES && input.context_units.length > 1) {
    input.context_units.shift();
  }
  if (input.context_units.length && jsonBytes(input.context_units) > MEMORY_CONTEXT_BYTES) {
    const context = input.context_units[0]!;
    const original = Buffer.from(context.text);
    const boundaries = graphemeByteBoundaries(context.text);
    let lower = 0;
    let upper = boundaries.length - 1;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      const text = original.subarray(boundaries[middle]!).toString("utf8");
      if (jsonBytes([{ ...context, text }]) <= MEMORY_CONTEXT_BYTES) upper = middle;
      else lower = middle + 1;
    }
    context.text = original.subarray(boundaries[lower]!).toString("utf8");
    if (!context.text || jsonBytes(input.context_units) > MEMORY_CONTEXT_BYTES) input.context_units.shift();
  }
  while (jsonBytes(input.candidates) > MEMORY_CANDIDATE_BYTES && input.candidates.length) {
    input.candidates.pop();
  }
  while (jsonBytes(input) > MEMORY_EXTRACT_INPUT_BYTES && input.context_units.length) {
    input.context_units.shift();
  }
  while (jsonBytes(input) > MEMORY_EXTRACT_INPUT_BYTES && input.candidates.length) {
    input.candidates.pop();
  }
  if (jsonBytes(input) > MEMORY_EXTRACT_INPUT_BYTES) {
    throw new Error("memory_extract_input_exceeds_budget");
  }
  return input;
}

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
