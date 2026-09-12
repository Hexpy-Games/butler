import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { initializeEmptyMemoryGeneration } from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";
import { ingestConversationMemory, advanceNextMemoryProjection } from "../../packages/butler-agent/src/agent/cognition/memory/index.ts";
import { recallSourceBackedMemory } from "../../packages/butler-agent/src/agent/cognition/memory/recall/engine.ts";
import { OPENAI_PROVIDER_ADAPTER } from "../../packages/butler-agent/src/integrations/providers/openai/adapter.ts";
import { runStructuredMemoryExtractor, type ExtractionStageResult } from "../../packages/butler-agent/src/agent/cognition/memory/projection/extractor.ts";
import { sourcePassages, meaningToOutput, validateMeaning, type Meaning } from "../../packages/butler-agent/src/agent/cognition/memory/projection/meaning.ts";
import { prepareBindingBatches, applyBinding, applyBindingRepair } from "../../packages/butler-agent/src/agent/cognition/memory/projection/binding.ts";
import { splitMeaningSourceSpans } from "../../packages/butler-agent/src/agent/cognition/memory/projection/windows.ts";
import type { ExtractInput } from "../../packages/butler-agent/src/agent/cognition/memory/projection/contracts.ts";

const text = "相機を使うには代理 または外部ブラウザーが必要です。";
const input: ExtractInput = { schema: "butler.memory-extract-input.v2", episode_ref: "episode", revision: "revision", window_ref: "window", bound_project_id: null,
  source_units: [{ ref: "canonical", text, role: "user", origin_kind: "user_input", observed_at: "2026-09-12T00:00:00Z" }], context_units: [], candidates: [] };
const meaning: Meaning = { status: "processed", entities: [{ name: "相機", evidence: [0] }, { name: "代理", evidence: [0] }, { name: "外部ブラウザー", evidence: [0] }],
  items: [{ kind: "requires", subject: 0, action: "使う", condition: { any: [{ subject: 1, state: "利用" }, { subject: 2, state: "利用" }] }, evidence: [0] }], attributes: [] };
const empty: Meaning = { status: "processed", entities: [], items: [], attributes: [] };
const response = (value: unknown) => ({ text: JSON.stringify(value), model: "gpt-5.6-sol", usage: null });

test("public ingestion preserves source roles and OR in stored graph and recall from either operand", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-meaning-public-"));
  const original = OPENAI_PROVIDER_ADAPTER.runPrompt;
  const requests: any[] = [];
  OPENAI_PROVIDER_ADAPTER.runPrompt = async (request) => {
    const prompt = JSON.parse(request.prompt); requests.push(prompt);
    return response(prompt.speaker === "user" ? meaning : empty) as never;
  };
  try {
    const descriptor = initializeEmptyMemoryGeneration(root);
    expect(JSON.parse(readFileSync(join(root, "cognition/memory/generations", descriptor.generation_id, "manifest.json"), "utf8")).extraction_version).toBe("memory-extract-v3");
    const context = { butlerData: root, target: { kind: "active" as const, expected_generation: descriptor.generation_id }, signal: AbortSignal.timeout(20000) };
    const store = new AgentConversationStore({ butlerData: root });
    const turn = store.beginTurn({ gateway: "app", externalSessionId: "session", sessionId: "session", projectId: null, actor: "user", turnId: "turn" });
    const user = store.appendUserMessage({ sessionId: "session", turnId: turn.id, text, originKind: "user_input", originRef: "app:turn:user" });
    const assistant = store.appendAssistantMessage({ sessionId: "session", turnId: turn.id, text: "了解しました。", originKind: "assistant_public", originRef: "app:turn:assistant" });
    store.finalizeTurn({ turnId: turn.id, status: "complete", outcomeCapsule: { sessionId: "session", turnId: turn.id, generation: 1, outcome: "delivered", requestMessageId: user.id, publicAssistantMessageId: assistant.id, providerId: "test", modelRef: "test/model" } });
    store.close();
    await ingestConversationMemory({ context, source: { kind: "conversation_turn", session_id: "session", turn_id: "turn", outcome_generation: 1 } });
    const db = new Database(join(root, "cognition/memory/generations", descriptor.generation_id, "graph.sqlite"));
    for (let count = 0; count < 8; count++) {
      const remaining = db.query<{ count: number }, []>("SELECT count(*) count FROM memory_projection_windows WHERE state!='complete'").get()!.count;
      if (!remaining) break;
      await advanceNextMemoryProjection({ context });
    }
    expect(db.query("SELECT state,error_code FROM memory_projection_windows WHERE state!='complete'").all()).toEqual([]);
    expect(requests.filter((item) => item.speaker).map((item) => item.speaker).sort()).toEqual(["assistant", "user"]);
    expect(requests.every((item) => !item.candidates && !item.episode_ref)).toBe(true);
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM edges WHERE rel_type='condition_member'").get()!.n).toBe(2);
    for (const cue of ["代理", "外部ブラウザー"]) {
      const result = await recallSourceBackedMemory({ context, cue, includeVector: false, includeInternal: false, limit: 5, scope: "all_user_sessions", projectFilter: "any", projectIds: [], sessionIds: [], asOf: new Date().toISOString(), runtime: { sessionId: "session", turnId: "query", currentUserMessage: cue, nativeOperationId: "query", projectId: null } });
      const requirements = result.results.flatMap((item) => item.requirements ?? []);
      expect(requirements).toHaveLength(1);
      expect(requirements[0]!.condition).toHaveProperty("any");
      expect(requirements[0]!.basis).toBe("user_statement");
      expect(requirements[0]!.source_refs.length).toBeGreaterThan(0);
    }
    // An already admitted v2 revision survives extractor upgrades without new work.
    db.query("UPDATE memory_projection_jobs SET extraction_version='memory-extract-v2'").run();
    const before = ["memory_projection_jobs", "memory_projection_windows", "memory_projection_attempts", "memory_chunk_sources"]
      .map((table) => db.query(`SELECT * FROM ${table}`).all());
    const calls = requests.length;
    await ingestConversationMemory({ context, source: { kind: "conversation_turn", session_id: "session", turn_id: "turn", outcome_generation: 1 } });
    expect(["memory_projection_jobs", "memory_projection_windows", "memory_projection_attempts", "memory_chunk_sources"]
      .map((table) => db.query(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(requests.length).toBe(calls);
    db.close();
  } finally { OPENAI_PROVIDER_ADAPTER.runPrompt = original; rmSync(root, { recursive: true, force: true }); }
}, 25000);

test("B failure resumes from durable A without a second meaning call", async () => {
  const original = OPENAI_PROVIDER_ADAPTER.runPrompt;
  const saved = new Map<string, ExtractionStageResult>();
  const kinds: string[] = [];
  let fail = true;
  OPENAI_PROVIDER_ADAPTER.runPrompt = async (request) => {
    const prompt = JSON.parse(request.prompt); kinds.push(prompt.parts ? "A" : "B");
    if (prompt.parts) return response(meaning) as never;
    if (fail) throw new Error("bounded-B-failure");
    return response({ decisions: prompt.targets.map((target: any) => ({ target: target.target, candidate: null, span: null, support: [] })) }) as never;
  };
  const root = mkdtempSync(join(tmpdir(), "memory-stage-"));
  try {
    const args = { butlerData: root, extractInput: structuredClone(input), model: "openai/gpt-5.6-sol", reasoningEffort: "medium", signal: AbortSignal.timeout(10000),
      loadCandidates: async () => [{ ref: "old-camera", type: "entity" as const, label: "相機", aliases: [], scope: "user" as const, project_id: null, evidence: [{ ref: "past", text: "相機を覚えて。", observed_at: "2026-09-01", basis: "user_statement" as const }] }],
      stages: { load: async (key: string) => saved.get(key) ?? null, save: async (key: string, result: ExtractionStageResult) => { saved.set(key, result); } } };
    await expect(runStructuredMemoryExtractor(args)).rejects.toThrow("bounded-B-failure");
    fail = false;
    const result = await runStructuredMemoryExtractor(args);
    expect(kinds).toEqual(["A", "B", "B"]);
    expect(result.output.claims[0]!.requirement!.condition).toHaveProperty("any");
    expect(result.evidence.stages[0]!.reused).toBe(true);
  } finally { OPENAI_PROVIDER_ADAPTER.runPrompt = original; rmSync(root, { recursive: true, force: true }); }
});

test("code preserves Unicode source spans and patches only the selected legacy value", async () => {
  const long = "العربية 日本語 cafe\u0301 👩🏽‍🚀。".repeat(80);
  const spans = splitMeaningSourceSpans(long, 4096);
  expect(spans.map((span) => Buffer.from(long).subarray(span.start, span.end).toString()).join("")).toBe(long);
  const current = { ...input, source_units: [{ ...input.source_units[0]!, text: "username pi를 admin으로 바꿔." }] };
  const change: Meaning = { status: "processed", entities: [], items: [{ kind: "change", subject: null, field: "username", old: "pi", new: "admin", evidence: [0] }], attributes: [] };
  const parts = sourcePassages(current);
  validateMeaning(change, parts);
  const output = meaningToOutput(current, change, parts);
  const old = "ssh pi@server, key pi_rsa";
  const prepared = await prepareBindingBatches(change, parts, async () => [{ ref: "old", type: "memory_atom", label: old, aliases: [], scope: "user", project_id: null,
    claim: { statement: old, subject_ref: null, object_ref: null, relation: null, polarity: "positive", condition: null },
    evidence: [{ ref: "history", text: old, observed_at: "2026-09-01", basis: "user_statement" }] }]);
  current.candidates = prepared.candidates;
  const batch = prepared.batches[0]!;
  const target = batch.prompt.targets[0]!, candidate = target.candidates[0]!;
  const selected = { decisions: [{ target: target.target, candidate: candidate.ref, span: candidate.spans![0]!.ref, support: [...target.evidence, ...candidate.evidence] }] };
  applyBinding(selected, batch, output, current);
  expect(output.claims[0]!.statement).toBe("ssh admin@server, key pi_rsa");
  expect(output.corrections[0]!.previous_claim_ref).toBe("old");
  selected.decisions[0]!.span = "unknown";
  expect(() => applyBinding(selected, batch, output, current)).toThrow("memory_extract_invalid_binding");
});


test("legacy mixed windows split before A while completed rows and original text survive", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-upgrade-"));
  const original = OPENAI_PROVIDER_ADAPTER.runPrompt;
  const requests: any[] = [];
  OPENAI_PROVIDER_ADAPTER.runPrompt = async (request) => { requests.push(JSON.parse(request.prompt)); return response(empty) as never; };
  try {
    const descriptor = initializeEmptyMemoryGeneration(root);
    const context = { butlerData: root, target: { kind: "active" as const, expected_generation: descriptor.generation_id }, signal: AbortSignal.timeout(25000) };
    const store = new AgentConversationStore({ butlerData: root });
    const userText = "x".repeat(900), assistantText = "はい。 العربية 👩🏽‍🚀";
    const turn = store.beginTurn({ gateway: "app", externalSessionId: "session", sessionId: "session", projectId: null, actor: "user", turnId: "turn" });
    const user = store.appendUserMessage({ sessionId: "session", turnId: turn.id, text: userText, originKind: "user_input", originRef: "app:turn:user" });
    const assistant = store.appendAssistantMessage({ sessionId: "session", turnId: turn.id, text: assistantText, originKind: "assistant_public", originRef: "app:turn:assistant" });
    store.finalizeTurn({ turnId: turn.id, status: "complete", outcomeCapsule: { sessionId: "session", turnId: turn.id, generation: 1, outcome: "delivered", requestMessageId: user.id, publicAssistantMessageId: assistant.id, providerId: "test", modelRef: "test/model" } }); store.close();
    await ingestConversationMemory({ context, source: { kind: "conversation_turn", session_id: "session", turn_id: "turn", outcome_generation: 1 } });
    const db = new Database(join(root, "cognition/memory/generations", descriptor.generation_id, "graph.sqlite"));
    const windows = db.query<any, []>("SELECT * FROM memory_projection_windows ORDER BY ordinal").all();
    // Reconstruct the old allocation: one mixed pending window, with a later completed row.
    const refs = windows.flatMap((row) => JSON.parse(row.source_refs_json));
    db.query("UPDATE memory_projection_windows SET source_refs_json=? WHERE window_ref=?").run(JSON.stringify(refs), windows[0].window_ref);
    db.query("UPDATE memory_projection_windows SET state='complete',source_refs_json='[]' WHERE window_ref=?").run(windows[1].window_ref);
    const completed = db.query("SELECT * FROM memory_projection_windows WHERE window_ref=?").get(windows[1].window_ref);
    // Earlier neighboring extraction already uses this still-unprocessed source as evidence.
    const parentSource = db.query<any, any[]>("SELECT * FROM memory_chunk_sources WHERE source_id=?").get(refs[0]);
    db.exec("PRAGMA foreign_keys=ON");
    db.query("INSERT INTO entities(id,type,label_original,identity_scope,created_at) VALUES('prior','entity','prior','user','2026-01-01')").run();
    db.query("INSERT INTO entity_aliases(entity_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES('prior','prior','prior','prior',?,'create')").run(refs[0]);
    db.query("INSERT INTO entity_mentions(entity_id,source_id,episode_id,revision) VALUES('prior',?,?,?)").run(refs[0],parentSource.episode_id,parentSource.revision);
    db.query("INSERT INTO edges(edge_id,source_node_id,target_node_id,rel_type) VALUES('prior-edge','prior','prior','test')").run();
    db.query("INSERT INTO edge_evidence(edge_id,chunk_source_id,basis,extraction_version) VALUES('prior-edge',?,'user_statement','test')").run(refs[0]);
    const priorEvidence = ["entity_aliases", "entity_mentions", "edge_evidence"].map(table => db.query(`SELECT * FROM ${table}`).all());

    for (let count = 0; count < 12; count++) {
      if (!db.query<{ n: number }, []>("SELECT count(*) n FROM memory_projection_windows WHERE state NOT IN ('complete','replaced')").get()!.n) break;
      await advanceNextMemoryProjection({ context });
    }
    expect(db.query("SELECT state,error_code FROM memory_projection_windows WHERE state NOT IN ('complete','replaced')").all()).toEqual([]);
    expect(db.query("SELECT * FROM memory_projection_windows WHERE window_ref=?").get(windows[1].window_ref)).toEqual(completed);

    expect(db.query("SELECT * FROM memory_chunk_sources WHERE source_id=?").get(refs[0])).toEqual(parentSource);
    expect(db.query("SELECT * FROM memory_source_leaves WHERE source_id=?").get(refs[0])).toBeNull();
    expect(["entity_aliases", "entity_mentions", "edge_evidence"].map(table => db.query(`SELECT * FROM ${table}`).all())).toEqual(priorEvidence);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(requests.map((p) => p.speaker)).toEqual(["user", "user", "assistant"]);
    const texts = requests.map((p) => p.parts.map((part: any) => part.text).join(""));
    expect(texts.join("")).toBe(userText + assistantText);
    expect(texts.every((part) => [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(part)].length <= 512)).toBe(true);
    expect(requests.every((p) => Buffer.byteLength(JSON.stringify(p.parts)) <= 4096)).toBe(true);
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM memory_source_split_parents").get()!.n).toBeGreaterThan(0);
    db.close();
  } finally { OPENAI_PROVIDER_ADAPTER.runPrompt = original; rmSync(root, { recursive: true, force: true }); }
}, 30000);


test("unresolved corrections preserve the new source claim and produce a warning", async () => {
  for (const old of ["previous", null]) {
    const current = { ...input, source_units: [{ ...input.source_units[0]!, text: "Change the notice to: taking a break." }] };
    const meaning: Meaning = { status: "processed", entities: [], items: [{ kind: "change", subject: null, field: "notice", old, new: "taking a break", evidence: [0] }], attributes: [] };
    const parts = sourcePassages(current);
    const output = meaningToOutput(current, meaning, parts);
    const before = structuredClone(output);
    const { batches } = await prepareBindingBatches(meaning, parts, async () => []);
    const warnings = applyBinding({ decisions: [{ target: "f0", candidate: null, span: null, support: [] }] }, batches[0]!, output, current);
    expect(warnings).toEqual([{ code: "correction_unresolved", target_ref: "f0" }]);
    expect(output).toEqual(before);
    expect(output.claims[0]!.statement).toBe(current.source_units[0]!.text);
    expect(output.corrections).toEqual([]);
  }
});

test("invalid cached A is preserved while a bounded correction supplies the reusable result", async () => {
  const original = OPENAI_PROVIDER_ADAPTER.runPrompt;
  const saved = new Map<string, ExtractionStageResult>();
  const requests: any[] = [];
  const invalid = { status: "processed", entities: [], items: [{ kind: "fact", subject: null, text: "stated fact", evidence: [5667] }], attributes: [] };
  const valid = { ...invalid, items: [{ ...invalid.items[0], evidence: [0] }] };
  OPENAI_PROVIDER_ADAPTER.runPrompt = async request => { requests.push(request); return response(requests.length === 1 ? invalid : valid) as never; };
  const root = mkdtempSync(join(tmpdir(), "memory-stage-repair-"));
  try {
    const args = { butlerData: root, extractInput: structuredClone(input), model: "openai/gpt-5.6-sol", reasoningEffort: "medium", signal: AbortSignal.timeout(10000),
      loadCandidates: async () => [], stages: { load: async (key: string) => saved.get(key) ?? null, save: async (key: string, result: ExtractionStageResult) => { saved.set(key, result); } } };
    const result = await runStructuredMemoryExtractor(args);
    expect(result.output.claims).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[1].prompt).correction.error).toBe("memory_extract_invalid_evidence");
    expect(requests[1].responseFormat.schema.properties.entities.items.properties.evidence.items.maximum).toBe(sourcePassages(input).length - 1);
    const snapshot = JSON.stringify([...saved]);
    await runStructuredMemoryExtractor(args);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify([...saved])).toBe(snapshot);
    expect([...saved.values()][0]!.raw).toBe(JSON.stringify(invalid));
  } finally { OPENAI_PROVIDER_ADAPTER.runPrompt = original; rmSync(root, { recursive: true, force: true }); }
});

test("stage repair exhaustion never issues further calls for the same saved invalid responses", async () => {
  const original = OPENAI_PROVIDER_ADAPTER.runPrompt;
  const saved = new Map<string, ExtractionStageResult>(); let calls = 0;
  OPENAI_PROVIDER_ADAPTER.runPrompt = async () => { calls++; return response({ ...empty, entities: [{ name: "x", evidence: [5667] }] }) as never; };
  const root = mkdtempSync(join(tmpdir(), "memory-stage-cap-"));
  try {
    const args = { butlerData: root, extractInput: structuredClone(input), model: "openai/gpt-5.6-sol", reasoningEffort: "medium", signal: AbortSignal.timeout(10000),
      loadCandidates: async () => [], stages: { load: async (key: string) => saved.get(key) ?? null, save: async (key: string, result: ExtractionStageResult) => { saved.set(key, result); } } };
    for (let n = 0; n < 2; n++) {
      const error = await runStructuredMemoryExtractor(args).then(() => null, error => error);
      expect(error.repairExhausted).toBe(true);
      expect(error.message).toBe("memory_extract_invalid_evidence");
    }
    expect(calls).toBe(3); expect(saved.size).toBe(3);
  } finally { OPENAI_PROVIDER_ADAPTER.runPrompt = original; rmSync(root, { recursive: true, force: true }); }
});

test("only invalid B is repaired and partial binding mutations are discarded", async () => {
  const original = OPENAI_PROVIDER_ADAPTER.runPrompt;
  const saved = new Map<string, ExtractionStageResult>(); const requests: any[] = []; let a = 0, b = 0;
  OPENAI_PROVIDER_ADAPTER.runPrompt = async request => {
    const wire = JSON.parse(request.prompt), prompt = wire.input ?? wire; requests.push(wire);
    if (prompt.parts) { a++; return response(meaning) as never; }
    b++;
    if (!wire.correction) {
      const initial = (request.responseFormat as any).schema.properties.decisions.items.properties;
      expect(initial.support).toBeTruthy();
      expect(initial.current_support).toBeUndefined();
      expect(initial.selected_historical_support).toBeUndefined();
    }
    if (wire.correction) {
      expect(wire.correction.error).toContain("memory_extract_invalid_identity_reuse");
      expect(wire.correction.error).toContain(`target=${prompt.targets[1].target}`);
      expect(wire.correction.error).toContain(`candidate=${prompt.targets[1].candidates[0].ref}`);
      expect(wire.correction.error).toContain("missing=selected_historical");
      expect(wire.correction.error).toContain(`offered_current=${prompt.targets[1].evidence.join(",")}`);
      expect(wire.correction.error).toContain(`offered_selected_historical=${prompt.targets[1].candidates[0].evidence.join(",")}`);
      expect(wire.correction.instruction).toContain("current_support");
      expect(wire.correction.instruction).toContain("selected_historical_support");
      const choices = (request.responseFormat as any).schema.properties.decisions.items.anyOf;
      const selected = choices[1].properties;
      expect(selected.target.enum).toEqual(prompt.targets.map((target: any) => target.target));
      expect(selected.candidate.enum).toEqual(prompt.targets.flatMap((target: any) => target.candidates.map((candidate: any) => candidate.ref)));
      expect(selected.span.enum).toEqual([null]);
      expect(selected.current_support).toMatchObject({ minItems: 1, maxItems: 3,
        items: { enum: prompt.targets.flatMap((target: any) => target.evidence) } });
      expect(selected.selected_historical_support).toMatchObject({ minItems: 1, maxItems: 1,
        items: { enum: prompt.targets.flatMap((target: any) => target.candidates.flatMap((candidate: any) => candidate.evidence)) } });
      expect(choices[0].properties).toMatchObject({ candidate: { type: "null" }, span: { type: "null" },
        current_support: { maxItems: 0 }, selected_historical_support: { maxItems: 0 } });
    }
    return response({ decisions: prompt.targets.map((target: any, index: number) => b === 1
      ? { target: target.target, candidate: index < 2 ? target.candidates[0].ref : null, span: null,
          support: index === 0 ? [...target.evidence, ...target.candidates[0].evidence] : index === 1 ? [...target.evidence] : [] }
      : { target: target.target, candidate: null, span: null, current_support: [], selected_historical_support: [] }) }) as never;
  };
  const root = mkdtempSync(join(tmpdir(), "memory-binding-repair-"));
  try {
    const result = await runStructuredMemoryExtractor({ butlerData: root, extractInput: structuredClone(input), model: "openai/gpt-5.6-sol", reasoningEffort: "medium", signal: AbortSignal.timeout(10000),
      loadCandidates: async () => [{ ref: "old-camera", type: "entity", label: "相機", aliases: [], scope: "user", project_id: null, evidence: [{ ref: "past", text: "相機を覚えて。", observed_at: "2026-09-01", basis: "user_statement" }] }],
      stages: { load: async key => saved.get(key) ?? null, save: async (key, result) => { saved.set(key, result); } } });
    expect(a).toBe(1); expect(b).toBe(2);
    expect(result.output.nodes.every(node => node.resolution.kind === "create")).toBe(true);
    expect(requests.filter(request => request.parts)).toHaveLength(1);
    expect([...saved.values()].some(stage => JSON.parse(stage.raw).decisions?.[1]?.support?.length === 1)).toBe(true);
    expect(saved.size).toBe(3);
    const savedSnapshot = JSON.stringify([...saved]);
    await runStructuredMemoryExtractor({ butlerData: root, extractInput: structuredClone(input), model: "openai/gpt-5.6-sol", reasoningEffort: "medium", signal: AbortSignal.timeout(10000),
      loadCandidates: async () => [{ ref: "old-camera", type: "entity", label: "相機", aliases: [], scope: "user", project_id: null, evidence: [{ ref: "past", text: "相機を覚えて。", observed_at: "2026-09-01", basis: "user_statement" }] }],
      stages: { load: async key => saved.get(key) ?? null, save: async (key, result) => { saved.set(key, result); } } });
    expect(a).toBe(1); expect(b).toBe(2); expect(JSON.stringify([...saved])).toBe(savedSnapshot);
  } finally { OPENAI_PROVIDER_ADAPTER.runPrompt = original; rmSync(root, { recursive: true, force: true }); }
});

test("binding repair keeps current and selected historical evidence in their declared roles", async () => {
  const parts = sourcePassages(input);
  const output = meaningToOutput(input, meaning, parts);
  const prepared = await prepareBindingBatches(meaning, parts, async () => [
    { ref: "old-camera", type: "entity", label: "相機", aliases: [], scope: "user", project_id: null,
      evidence: [{ ref: "past", text: "相機を覚えて。", observed_at: "2026-09-01", basis: "user_statement" }] },
    { ref: "other-camera", type: "entity", label: "別の相機", aliases: [], scope: "user", project_id: null,
      evidence: [{ ref: "other-past", text: "別の相機を覚えて。", observed_at: "2026-09-01", basis: "user_statement" }] },
  ]);
  const batch = prepared.batches[0]!, target = batch.prompt.targets[0]!, candidate = target.candidates[0]!, other = target.candidates[1]!;
  const decisions = batch.prompt.targets.map((item, index) => index === 0
    ? { target: item.target, candidate: candidate.ref, span: null, current_support: item.evidence.slice(0, 1), selected_historical_support: candidate.evidence }
    : { target: item.target, candidate: null, span: null, current_support: [], selected_historical_support: [] });
  applyBindingRepair({ decisions }, batch, output, { ...input, candidates: prepared.candidates });
  expect(output.nodes[0]!.resolution).toMatchObject({ kind: "reuse", node_ref: "old-camera" });
  const swapped = structuredClone(decisions);
  swapped[0]!.current_support = candidate.evidence;
  swapped[0]!.selected_historical_support = target.evidence.slice(0, 1);
  expect(() => applyBindingRepair({ decisions: swapped }, batch, meaningToOutput(input, meaning, parts), { ...input, candidates: prepared.candidates }))
    .toThrow("memory_extract_invalid_identity_reuse");
  const wrongCandidate = structuredClone(decisions);
  wrongCandidate[0]!.selected_historical_support = other.evidence;
  expect(() => applyBindingRepair({ decisions: wrongCandidate }, batch, meaningToOutput(input, meaning, parts), { ...input, candidates: prepared.candidates }))
    .toThrow("memory_extract_invalid_identity_reuse");
  expect(() => applyBindingRepair({ decisions: [null] }, batch, meaningToOutput(input, meaning, parts), { ...input, candidates: prepared.candidates }))
    .toThrow("memory_extract_invalid_binding");
});
