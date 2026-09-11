import { expect, test } from "bun:test";
import type { ExtractInput } from "../../packages/butler-agent/src/agent/cognition/memory/projection/contracts.ts";
import { enforceExtractInputBudget, packExtractionCandidates } from "../../packages/butler-agent/src/agent/cognition/memory/projection/windows.ts";

type Candidate = ExtractInput["candidates"][number];
function candidate(ref: string, subject: string | null = null): Candidate {
  return {
    ref, type: subject ? "preference" : "entity", label: "雪 العربية 기억", aliases: ["雪 العربية 기억"],
    scope: "user", project_id: null,
    claim: subject ? { subject_ref: subject, object_ref: null, relation: null, polarity: "positive", condition: null } : null,
    evidence: [{ ref: `source-${ref}`, text: "雪 العربية 기억", observed_at: "2026-09-11T00:00:00Z", basis: "user_statement" }],
  };
}

test("claim candidates include shared endpoints before claims and remain closed after input trimming", () => {
  const values = [candidate("subject"), candidate("first", "subject"), candidate("second", "subject")];
  const byId = new Map(values.map((value) => [value.ref, value]));
  const packed = packExtractionCandidates(["first", "second"], (ref) => byId.get(ref) ?? null);
  expect(packed.map((value) => value.ref)).toEqual(["subject", "first", "second"]);
  const input: ExtractInput = {
    schema: "butler.memory-extract-input.v2", episode_ref: "episode", revision: "revision", window_ref: "window",
    bound_project_id: null, source_units: [{ ref: "current", text: "x".repeat(8 * 1024), role: "user", origin_kind: "user_input", observed_at: "2026-09-11T00:00:00Z" }],
    context_units: [], candidates: packed,
  };
  enforceExtractInputBudget(input);
  expect(input.candidates).toEqual(packed);
  // The real budget owner removes a suffix. Every possible remaining prefix must be closed.
  for (let count = 0; count <= packed.length; count++) {
    const prefix = packed.slice(0, count);
    const refs = new Set(prefix.map((value) => value.ref));
    for (const value of prefix) {
      if (value.claim?.subject_ref) expect(refs.has(value.claim.subject_ref)).toBe(true);
    }
  }
  expect(input.source_units[0]!.text.length).toBe(8 * 1024);
});

test("unavailable or cyclic dependencies are omitted and packing bounds graph reads and bytes", () => {
  const values = [candidate("missing", "unavailable"), candidate("cycle-a", "cycle-b"), candidate("cycle-b", "cycle-a"), candidate("valid")];
  const byId = new Map(values.map((value) => [value.ref, value]));
  expect(packExtractionCandidates(["missing", "cycle-a", "valid"], (ref) => byId.get(ref) ?? null).map((value) => value.ref)).toEqual(["valid"]);
  let reads = 0;
  const packed = packExtractionCandidates(Array.from({ length: 32 }, (_, i) => `claim-${i}`), (ref) => {
    reads++;
    const value = candidate(ref, ref.startsWith("claim-") ? `entity-${ref}` : null);
    value.label = "界".repeat(256);
    return value;
  });
  expect(reads).toBeLessThanOrEqual(96);
  expect(packed.length).toBeLessThanOrEqual(32);
  expect(Buffer.byteLength(JSON.stringify(packed))).toBeLessThanOrEqual(8 * 1024);
  const refs = new Set(packed.map((value) => value.ref));
  for (const value of packed) if (value.claim?.subject_ref) expect(refs.has(value.claim.subject_ref)).toBe(true);
});
