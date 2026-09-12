import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtractInput, ExtractOutput } from "../../packages/butler-agent/src/agent/cognition/memory/projection/contracts.ts";
import { extractOutputSchema, runStructuredMemoryExtractor } from "../../packages/butler-agent/src/agent/cognition/memory/projection/extractor.ts";
import { normalizeAndValidatePlan } from "../../packages/butler-agent/src/agent/cognition/memory/projection/plan.ts";
import { registerHostedModelConfig } from "../../packages/butler-agent/src/integrations/providers/shared/registered-models.ts";

const sourceText = "日本語 العربية cafe\u0301 👩🏽‍🚀 u0 조건";
const input: ExtractInput = {
  schema: "butler.memory-extract-input.v2", episode_ref: "episode", revision: "revision",
  window_ref: "window", bound_project_id: null, context_units: [], candidates: [],
  source_units: [{ ref: "canonical-source", text: sourceText, role: "user", origin_kind: "user_input", observed_at: "2026-09-12T00:00:00Z" }],
};

function withoutDescriptions(value: any): any {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "description")
    .map(([key, item]) => [key, withoutDescriptions(item)]));
}

function expand(value: any, definitions: Record<string, any>): any {
  if (Array.isArray(value)) return value.map((item) => expand(item, definitions));
  if (!value || typeof value !== "object") return value;
  if (value.$ref) {
    expect(value.$ref.startsWith("#/$defs/")).toBe(true);
    const definition = definitions[value.$ref.slice("#/$defs/".length)];
    expect(definition).toBeDefined();
    return expand(definition, definitions);
  }
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$defs")
    .map(([key, item]) => [key, expand(item, definitions)]));
}

async function withProvider(bodyOutput: (body: any) => any, inspect: (invoke: () => ReturnType<typeof runStructuredMemoryExtractor>, bodies: any[], evidence: any[]) => Promise<void>, extractInput = input) {
  const root = mkdtempSync(join(tmpdir(), "memory-extractor-contract-"));
  const oldData = process.env.BUTLER_DATA;
  const oldFetch = globalThis.fetch;
  const bodies: any[] = [];
  const evidence: any[] = [];
  try {
    process.env.BUTLER_DATA = root;
    registerHostedModelConfig({ providerId: "zai", modelId: "glm-5.3", authType: "api_key", apiKey: "test-only" }, root);
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return new Response(JSON.stringify({ model: "glm-5.3", choices: [{ message: { role: "assistant", content: JSON.stringify(bodyOutput(body)) }, finish_reason: "stop" }] }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    await inspect(() => runStructuredMemoryExtractor({ butlerData: root, extractInput, model: "zai/glm-5.3", reasoningEffort: "high", signal: AbortSignal.timeout(5000), onRequestPrepared: (value) => evidence.push(value) }), bodies, evidence);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldData === undefined) delete process.env.BUTLER_DATA; else process.env.BUTLER_DATA = oldData;
    rmSync(root, { recursive: true, force: true });
  }
}

function emptyOutput(disposition: "processed" | "unsupported", covered: string[]): ExtractOutput {
  return { schema: "butler.memory-extract-output.v2", window_ref: "window", disposition, covered_unit_refs: covered, nodes: [], claims: [], relations: [], corrections: [], summary: null };
}

test("actual GLM wire compacts the same schema and preserves Unicode and request hashes", async () => {
  await withProvider(() => ({ ...emptyOutput("processed", ["u0"]), summary: { text: sourceText, evidence: [{ unit_ref: "u0", quote: sourceText, occurrence: 0 }] } }), async (invoke, bodies, evidence) => {
    const result = await invoke();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: "glm-5.3", reasoning_effort: "high", response_format: { type: "json_object" } });
    const bridge = "\n\nReturn exactly one JSON object matching the following JSON Schema. Do not wrap it in Markdown or add explanatory text.\n";
    const [instructions, schemaText] = bodies[0].messages[0].content.split(bridge);
    const schema = JSON.parse(schemaText);
    expect(Object.keys(schema.$defs)).toEqual(["Quote", "Evidence", "Resolution"]);
    expect(expand(schema, schema.$defs)).toEqual(withoutDescriptions(extractOutputSchema()));
    expect(schemaText.length).toBeLessThan(JSON.stringify(extractOutputSchema()).length / 2);
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    expect(evidence[0].instructions_sha256).toBe(hash(instructions));
    expect(evidence[0].output_schema_sha256).toBe(hash(schemaText));
    expect(evidence[0].input_json_sha256).toBe(hash(bodies[0].messages[1].content));
    expect(JSON.parse(bodies[0].messages[1].content).source_units[0]).toEqual({ ...input.source_units[0], ref: "u0" });
    expect(result.output.covered_unit_refs).toEqual(["canonical-source"]);
    expect(result.output.summary?.evidence[0]).toEqual({ unit_ref: "canonical-source", quote: sourceText, occurrence: 0 });
    expect(() => normalizeAndValidatePlan(null as never, input, result.output)).not.toThrow();
  });
});

test("unsupported coverage rule is sent and enforced without a provider retry", async () => {
  for (const covered of [[], ["u0"]]) {
    await withProvider(() => emptyOutput("unsupported", covered), async (invoke, bodies) => {
      if (covered.length) await expect(invoke()).rejects.toThrow("memory_extract_invalid_output");
      else expect((await invoke()).output).toEqual(emptyOutput("unsupported", []));
      expect(bodies).toHaveLength(1);
      expect(bodies[0].messages[0].content).toContain("unsupported: covered_unit_refs, nodes, claims, relations and corrections are []; summary is null.");
    });
  }
});

test("candidate handles restore only identity and correction refs, preserving local handles and Unicode text", async () => {
  const text = sourceText + " c0";
  const history = { ref: "historical-source", text, basis: "user_statement" as const, observed_at: "2026-09-11T00:00:00Z" };
  const candidateInput: ExtractInput = { ...input, source_units: [{ ...input.source_units[0]!, text }], candidates: [
    { ref: "stored-entity-id", type: "entity", label: "c0", aliases: [], scope: "user", project_id: null, evidence: [history] },
    { ref: "stored-claim-id", type: "constraint", label: text, aliases: [], scope: "user", project_id: null, evidence: [history],
      claim: { subject_ref: "stored-entity-id", object_ref: "c0", relation: "depends_on", polarity: "positive", condition: null } },
  ] };
  const currentEvidence = [{ unit_ref: "u0", quote: text, occurrence: 0 }];
  const reuseEvidence = [...currentEvidence, { unit_ref: "u1", quote: text, occurrence: 0 }];
  const makeOutput = (candidateRef: string) => ({ ...emptyOutput("processed", ["u0"]),
    nodes: [{ local_ref: "c0", type: "entity", label: "c0", aliases: [], evidence: currentEvidence,
      resolution: { kind: "reuse", node_ref: candidateRef, reason: "named_context", evidence: reuseEvidence } }],
    claims: [{ local_ref: "f0", type: "constraint", statement: text, subject_ref: "c0", object_ref: null,
      speech_act: "assertion", basis: "user_statement", polarity: "positive", condition: null, valid_from: null, valid_to: null, salience: "normal",
      resolution: { kind: "create", provisional: false, identity_scope: "user" }, evidence: currentEvidence }],
    corrections: [{ previous_claim_ref: "c2", replacement_claim_ref: "f0", relation: "supersedes", effective_at: null, evidence: reuseEvidence }],
  });
  const before = JSON.stringify(candidateInput);
  await withProvider(() => makeOutput("c1"), async (invoke, bodies, evidence) => {
    const result = await invoke();
    const wire = JSON.parse(bodies[0].messages[1].content);
    expect(wire.candidates.map((value: any) => value.ref)).toEqual(["c1", "c2"]);
    expect(wire.candidates[1].claim).toMatchObject({ subject_ref: "c1", object_ref: "c0" });
    expect(wire.candidates[0].claim).toBeUndefined();
    expect(wire.source_units[0].text).toBe(text);
    expect(evidence[0].profile).toBe("memory-extract-short-refs.v2");
    expect(result.output.nodes[0]).toMatchObject({ local_ref: "c0", label: "c0", resolution: { node_ref: "stored-entity-id" } });
    expect(result.output.claims[0]).toMatchObject({ subject_ref: "c0", statement: text });
    expect(result.output.corrections[0]).toMatchObject({ previous_claim_ref: "stored-claim-id", replacement_claim_ref: "f0" });
    expect(result.output.nodes[0]!.evidence[0]!.quote).toBe(text);
    expect(JSON.stringify(candidateInput)).toBe(before);
  }, candidateInput);
  for (const unknown of ["c0", "c9", "stored-entity-id"]) {
    await withProvider(() => makeOutput(unknown), async (invoke, bodies) => {
      await expect(invoke()).rejects.toThrow("memory_extract_invalid_ref");
      expect(bodies).toHaveLength(1);
    }, candidateInput);
  }
});
