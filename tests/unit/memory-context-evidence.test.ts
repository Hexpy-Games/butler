import { insertMemoryNodeFixture } from "../helpers/memory-node-fixture.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { initializeEmptyMemoryGeneration, prepareMemoryRebuild } from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";
import { ingestConversationMemory } from "../../packages/butler-agent/src/agent/cognition/memory/projection/ingestion.ts";
import { createContextEvidenceResolver } from "../../packages/butler-agent/src/agent/cognition/memory/projection/context-evidence.ts";
import { projectionHash } from "../../packages/butler-agent/src/agent/cognition/memory/projection/source.ts";
import { runMemoryRebuildCommand } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/consolidation-cycle.ts";
import {
  openProjectionDb,
  type ProjectionSourceRow,
} from "../../packages/butler-agent/src/agent/cognition/memory/projection/store.ts";
import type { ExtractInput, ExtractOutput } from "../../packages/butler-agent/src/agent/cognition/memory/projection/contracts.ts";
import { applyPlan, normalizeAndValidatePlan } from "../../packages/butler-agent/src/agent/cognition/memory/projection/plan.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fixture(
  secondText = "العربية 日本語 끝  ",
  firstText = "  앞말 ",
  assistantText = "확인했습니다.",
) {
  const root = mkdtempSync(join(tmpdir(), "memory-context-evidence-"));
  roots.push(root);
  const descriptor = initializeEmptyMemoryGeneration(root);
  const store = new AgentConversationStore({ butlerData: root });
  const turn = store.beginTurn({
    gateway: "app",
    externalSessionId: "session",
    sessionId: "session",
    projectId: null,
    actor: "user",
    turnId: "turn",
  });
  const user = store.appendUserMessage({
    sessionId: "session",
    turnId: turn.id,
    text: "",
    originKind: "user_input",
    originRef: "app:turn:user",
    parts: [
      { kind: "text", contentJson: { text: firstText } },
      { kind: "text", contentJson: { text: secondText } },
    ],
  });
  const assistant = store.appendAssistantMessage({
    sessionId: "session",
    turnId: turn.id,
    text: assistantText,
    originKind: "assistant_public",
    originRef: "app:turn:assistant",
  });
  store.finalizeTurn({
    turnId: turn.id,
    status: "complete",
    outcomeCapsule: {
      sessionId: "session",
      turnId: turn.id,
      generation: 1,
      outcome: "delivered",
      requestMessageId: user.id,
      publicAssistantMessageId: assistant.id,
      providerId: "test",
      modelRef: "test/model",
    },
  });
  store.close();
  await ingestConversationMemory({
    context: {
      butlerData: root,
      target: { kind: "active", expected_generation: descriptor.generation_id },
      signal: new AbortController().signal,
    },
    source: {
      kind: "conversation_turn",
      session_id: "session",
      turn_id: turn.id,
      outcome_generation: 1,
    },
  });
  const db = openProjectionDb(
    join(
      root,
      "cognition/memory/generations",
      descriptor.generation_id,
      "graph.sqlite",
    ),
  );
  const sources = db
    .query<
      ProjectionSourceRow,
      [string]
    >("SELECT * FROM memory_chunk_sources WHERE conversation_message_id=? ORDER BY part_id,byte_start")
    .all(user.id);
  const current = db
    .query<
      ProjectionSourceRow,
      [string]
    >("SELECT * FROM memory_chunk_sources WHERE conversation_message_id=?")
    .get(assistant.id)!;
  const input: ExtractInput = {
    schema: "butler.memory-extract-input.v2",
    episode_ref: current.episode_id,
    revision: current.revision,
    window_ref: "window",
    bound_project_id: null,
    source_units: [
      {
        ref: current.source_id,
        text: "확인했습니다.",
        role: "assistant",
        origin_kind: "assistant_public",
        observed_at: current.observed_at,
      },
    ],
    context_units: [
      {
        ref: `conversation-message:${user.id}`,
        text: "앞말  العربية 日本語 끝",
        basis: "user_statement",
        observed_at: sources[0]!.observed_at,
      },
    ],
    candidates: [],
  };
  return {
    generationId: descriptor.generation_id,
    root,
    db,
    input,
    first: sources.find((row) => row.part_id === user.parts[0]!.id)!,
    second: sources.find((row) => row.part_id === user.parts[1]!.id)!,
    secondRows: sources.filter((row) => row.part_id === user.parts[1]!.id),
  };
}

function quote(input: ExtractInput, text: string) {
  const unit = input.context_units[0]!;
  const start = unit.text.indexOf(text);
  if (start < 0) throw new Error("fixture quote missing");
  const byteStart = Buffer.byteLength(unit.text.slice(0, start));
  return {
    sourceId: unit.ref,
    byteStart,
    byteEnd: byteStart + Buffer.byteLength(text),
    quote: text,
  };
}

test("maps multilingual message context across real parts and trimmed suffixes", async () => {
  const { root, db, input, first, second } = await fixture();
  try {
    const resolve = createContextEvidenceResolver(db, root, input);
    expect(resolve(quote(input, "말  العربية"))).toEqual([
      {
        sourceId: first.source_id,
        byteStart: Buffer.byteLength("  앞"),
        byteEnd: Buffer.byteLength("  앞말 "),
        quote: "말 ",
      },
      {
        sourceId: second.source_id,
        byteStart: 0,
        byteEnd: Buffer.byteLength("العربية"),
        quote: "العربية",
      },
    ]);
    input.context_units[0]!.text = "日本語 끝";
    expect(
      createContextEvidenceResolver(db, root, input)(quote(input, "日本語")),
    ).toEqual([
      {
        sourceId: second.source_id,
        byteStart: Buffer.byteLength("العربية "),
        byteEnd: Buffer.byteLength("العربية 日本語"),
        quote: "日本語",
      },
    ]);
    input.context_units[0] = {
      ...input.context_units[0]!,
      ref: second.source_id,
      text: "日本語 끝  ",
    };
    expect(
      createContextEvidenceResolver(db, root, input)(quote(input, "끝")),
    ).toEqual([
      {
        sourceId: second.source_id,
        byteStart: Buffer.byteLength("العربية 日本語 "),
        byteEnd: Buffer.byteLength("العربية 日本語 끝"),
        quote: "끝",
      },
    ]);
  } finally {
    db.close();
  }
});

test("correction edges persist multilingual context as canonical sources and replay without duplicate evidence", async () => {
  const { root, db, input, first, second } = await fixture();
  try {
    const row = db.query<{ window_ref: string; job_id: string }, []>(
      "SELECT window_ref,job_id FROM memory_projection_windows LIMIT 1",
    ).get()!;
    input.window_ref = row.window_ref;
    const current = input.source_units[0]!;
    const currentQuote = { unit_ref: current.ref, quote: current.text, occurrence: 0 };
    insertMemoryNodeFixture(db, { id: "prior", type: "memory_atom", label_original: "prior", claim: "{}", identity_scope: "user", project_id: null, created_at: current.observed_at });
    input.candidates = [{ ref: "prior", type: "memory_atom", label: "prior", aliases: [], scope: "user", project_id: null,
      evidence: [{ ref: current.ref, text: current.text, observed_at: current.observed_at, basis: "assistant_statement" }] }];
    const output: ExtractOutput = {
      schema: "butler.memory-extract-output.v2", window_ref: row.window_ref, disposition: "processed",
      covered_unit_refs: [current.ref], nodes: [], relations: [], summary: null,
      claims: [{ local_ref: "replacement", type: "memory_atom", statement: current.text,
        resolution: { kind: "create", provisional: false, identity_scope: "user" },
        subject_ref: null, object_ref: null, speech_act: "assertion", basis: "assistant_statement",
        polarity: "unspecified", condition: null, valid_from: null, valid_to: null, salience: "normal", evidence: [currentQuote] }],
      corrections: [{ previous_claim_ref: "prior", replacement_claim_ref: "replacement", relation: "supersedes", effective_at: null,
        evidence: [currentQuote, { unit_ref: input.context_units[0]!.ref, quote: "말  العربية", occurrence: 0 }] }],
    };
    const plan = normalizeAndValidatePlan(db, input, output);
    for (let replay = 0; replay < 2; replay++) {
      applyPlan(db, row.job_id, row.window_ref, input, output, plan, {}, root);
      const sources = db.query<{ chunk_source_id: string }, []>(
        "SELECT v.chunk_source_id FROM edge_evidence v JOIN edges e ON e.edge_id=v.edge_id WHERE e.rel_type='supersedes' ORDER BY v.chunk_source_id",
      ).all().map((entry) => entry.chunk_source_id);
      expect(sources).toEqual([current.ref, first.source_id, second.source_id].sort());
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    }
  } finally { db.close(); }
});

test("public retry-failed resumes a saved plan without clearing its provider result", async () => {
  const { root, db, input, generationId } = await fixture();
  try {
    const row = db
      .query<
        { window_ref: string },
        []
      >("SELECT window_ref FROM memory_projection_windows LIMIT 1")
      .get()!;
    const savedInput = JSON.stringify({ ...input, window_ref: row.window_ref });
    const savedOutput = JSON.stringify({
      schema: "butler.memory-extract-output.v2",
      window_ref: row.window_ref,
      disposition: "processed",
      covered_unit_refs: input.source_units.map((unit) => unit.ref),
      nodes: [],
      claims: [],
      relations: [],
      corrections: [],
      summary: null,
    });
    const savedPlan = JSON.stringify({
      refs: {},
      evidence: {},
      candidate_bindings: {},
    });
    db.query(
      "UPDATE memory_projection_windows SET state='failed',error_code='memory_extract_provider_failed',attempt_count=1,input_json=?,output_json=?,normalized_plan_json=? WHERE window_ref=?",
    ).run(savedInput, savedOutput, savedPlan, row.window_ref);
    const result = await runMemoryRebuildCommand({
      butlerData: root,
      argv: ["--memory-rebuild", "retry-failed", "--generation", generationId],
      signal: new AbortController().signal,
    });
    expect(result.retried).toEqual({
      semantic_windows: 1,
      vector_units: 0,
      cache_jobs: 0,
    });
    const after = db
      .query<
        {
          state: string;
          input_json: string;
          output_json: string;
          normalized_plan_json: string;
          attempt_count: number;
        },
        [string]
      >("SELECT state,input_json,output_json,normalized_plan_json,attempt_count FROM memory_projection_windows WHERE window_ref=?")
      .get(row.window_ref)!;
    expect(after).toEqual({
      state: "planned",
      input_json: savedInput,
      output_json: savedOutput,
      normalized_plan_json: savedPlan,
      attempt_count: 1,
    });
  } finally {
    db.close();
  }
});

test("rejects changed context, scope, source hashes and missing canonical spans", async () => {
  const { root, db, input, second } = await fixture();
  try {
    const changed = structuredClone(input);
    changed.context_units[0]!.text = "다른 문맥";
    expect(() =>
      createContextEvidenceResolver(db, root, changed)(quote(changed, "문맥")),
    ).toThrow("memory_source_changed");
    expect(() =>
      createContextEvidenceResolver(db, root, {
        ...input,
        bound_project_id: "different-project",
      })(quote(input, "日本語")),
    ).toThrow("memory_source_changed");
    for (const sql of [
      "UPDATE memory_chunk_sources SET content_hash='changed' WHERE source_id=?",
      "DELETE FROM memory_chunk_sources WHERE source_id=?",
    ]) {
      db.exec("BEGIN; PRAGMA defer_foreign_keys=ON");
      try {
        db.query(sql).run(second.source_id);
        expect(() =>
          createContextEvidenceResolver(
            db,
            root,
            input,
          )(quote(input, "日本語")),
        ).toThrow("memory_source_changed");
      } finally {
        db.exec("ROLLBACK");
      }
    }
  } finally {
    db.close();
  }
});

test("splits one context quote at canonical UTF-8 source slice boundaries", async () => {
  const { root, db, input, secondRows } = await fixture(
    "a".repeat(8190) + "日本語終",
    "",
  );
  try {
    // The canonical splitter records the boundary-crossing grapheme separately.
    expect(secondRows.map((row) => [row.byte_start, row.byte_end])).toEqual([
      [0, 8190],
      [8190, 8193],
      [8193, 8202],
    ]);
    input.context_units[0]!.text = "aa日本語終";
    expect(
      createContextEvidenceResolver(db, root, input)(quote(input, "aa日本語")),
    ).toEqual([
      {
        sourceId: secondRows[0]!.source_id,
        byteStart: 8188,
        byteEnd: 8190,
        quote: "aa",
      },
      {
        sourceId: secondRows[1]!.source_id,
        byteStart: 0,
        byteEnd: Buffer.byteLength("日"),
        quote: "日",
      },
      {
        sourceId: secondRows[2]!.source_id,
        byteStart: 0,
        byteEnd: Buffer.byteLength("本語"),
        quote: "本語",
      },
    ]);
  } finally {
    db.close();
  }
});


test("public candidate input repair preserves history, rolls back stale batches and protects completed windows", async () => {
  const { root, db, input, generationId, second } = await fixture();
  try {
    const window = db.query<{ window_ref: string }, []>("SELECT window_ref FROM memory_projection_windows LIMIT 1").get()!;
    for (const [id, type, label] of [["subject", "entity", "日本語"], ["claim", "preference", "العربية"]]) {
      insertMemoryNodeFixture(db, { id: id!, type: type!, label_original: label!, identity_scope: "user", created_at: second.observed_at });
      db.query("INSERT INTO memory_aliases(node_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES(?,?,?,?,?,'create')").run(id!, label!, label!, label!, second.source_id);
    }
    db.query("INSERT INTO edges(edge_id,source_node_id,target_node_id,rel_type,claim_node_id) VALUES('edge','claim','subject','has_subject','claim')").run();
    const original = JSON.stringify({ ...input, window_ref: window.window_ref, candidates: [{
      ref: "claim", type: "preference", label: "العربية", aliases: ["العربية"], scope: "user", project_id: null,
      claim: { subject_ref: "subject", object_ref: null, relation: null, polarity: null, condition: null },
      evidence: [{ ref: second.source_id, text: "العربية 日本語 끝", basis: "user_statement", observed_at: second.observed_at }],
    }] });
    const originalHash = projectionHash(["extract-input", original]);
    db.query("UPDATE memory_projection_windows SET input_json=?,input_sha256=? WHERE window_ref=?").run(original, originalHash, window.window_ref);
    const selected = { window_ref: window.window_ref, expected_input_sha256: originalHash, expected_attempt_count: 0 };
    const requestPath = join(root, "input-repair.json");
    const invoke = (windows: Array<typeof selected & { candidate_source_sha256?: string }>, dryRun = false) => {
      writeFileSync(requestPath, JSON.stringify({ schema: "butler.memory-candidate-input-repair.v1", windows }));
      return runMemoryRebuildCommand({ butlerData: root,
        argv: ["--memory-rebuild", "repair-inputs", "--generation", generationId, "--input", requestPath, ...(dryRun ? ["--dry-run"] : [])], signal: new AbortController().signal });
    };
    const row = () => db.query<{ input_json: string; input_sha256: string; state: string; attempt_count: number }, [string]>("SELECT input_json,input_sha256,state,attempt_count FROM memory_projection_windows WHERE window_ref=?").get(window.window_ref)!;
    await expect(invoke([selected, { ...selected, window_ref: "f".repeat(64) }])).rejects.toThrow("memory_input_repair_precondition_changed");
    expect(row().input_json).toBe(original);
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM memory_projection_attempts").get()!.n).toBe(0);
    const preview = await invoke([selected], true);
    expect((preview.receipts as any[])[0].repaired_candidates.map((value: any) => value.ref)).toEqual(["subject", "claim"]);
    expect(row().input_json).toBe(original);
    expect((await invoke([selected])).repaired).toBe(1);
    const repaired = JSON.parse(row().input_json) as ExtractInput;
    expect(repaired.candidates.map((value) => value.ref)).toEqual(["subject", "claim"]);
    expect(repaired.candidates.map(({ label, aliases }) => ({ label, aliases })))
      .toEqual([{ label: "日本語", aliases: ["日本語"] }, { label: "العربية", aliases: [] }]);
    expect(repaired.source_units).toEqual(input.source_units);
    expect(repaired.context_units).toEqual(input.context_units);
    expect(row().state).toBe("pending");
    expect(row().attempt_count).toBe(0);
    const archived = db.query<{ recovery_request_json: string; provider_invoked: number }, []>("SELECT recovery_request_json,provider_invoked FROM memory_projection_attempts").get()!;
    expect(JSON.parse(archived.recovery_request_json).prior_input_json).toBe(original);
    expect(archived.provider_invoked).toBe(0);
    await expect(invoke([selected])).rejects.toThrow("memory_input_repair_precondition_changed");
    const current = { ...selected, expected_input_sha256: row().input_sha256 };
    expect((await invoke([current])).repaired).toBe(0);
    const reduced = JSON.stringify({ ...repaired, candidates: repaired.candidates.filter((value) => value.type === "entity") });
    const reducedHash = projectionHash(["extract-input", reduced]);
    db.query("UPDATE memory_projection_windows SET input_json=?,input_sha256=? WHERE window_ref=?").run(reduced, reducedHash, window.window_ref);
    const restore = { ...current, expected_input_sha256: reducedHash, candidate_source_sha256: originalHash };
    await expect(invoke([{ ...restore, candidate_source_sha256: "0".repeat(64) }])).rejects.toThrow("memory_input_repair_precondition_changed");
    expect((await invoke([restore])).repaired).toBe(1);
    expect(JSON.parse(row().input_json).candidates.map((value: any) => value.ref)).toEqual(["subject", "claim"]);
    const history = db.query<{ recovery_request_json: string }, []>("SELECT recovery_request_json FROM memory_projection_attempts").all();
    expect(history.map((value) => JSON.parse(value.recovery_request_json).prior_input_json)).toEqual([original, reduced]);
    current.expected_input_sha256 = row().input_sha256;

    const tightInput = { ...JSON.parse(original), context_units: [{ ...input.context_units[0]!, text: "" }] };
    const emptyInputBytes = Buffer.byteLength(JSON.stringify({ ...tightInput, candidates: [] }));
    const insufficientCandidateBytes = Buffer.byteLength(JSON.stringify(repaired.candidates)) - 1;
    tightInput.context_units[0].text = "x".repeat(24 * 1024 - emptyInputBytes - insufficientCandidateBytes + 2);
    const fullContext = JSON.stringify(tightInput);
    const fullContextHash = projectionHash(["extract-input", fullContext]);
    db.query("UPDATE memory_projection_windows SET input_json=?,input_sha256=? WHERE window_ref=?").run(fullContext, fullContextHash, window.window_ref);
    await expect(invoke([{ ...current, expected_input_sha256: fullContextHash }])).rejects.toThrow("memory_input_repair_candidates_incomplete");
    expect(row().input_json).toBe(fullContext);
    const restoredJson = JSON.stringify(repaired);
    db.query("UPDATE memory_projection_windows SET input_json=?,input_sha256=? WHERE window_ref=?").run(restoredJson, projectionHash(["extract-input", restoredJson]), window.window_ref);
    current.expected_input_sha256 = row().input_sha256;

    db.query("UPDATE memory_projection_windows SET state='complete' WHERE window_ref=?").run(window.window_ref);
    await expect(invoke([current])).rejects.toThrow("memory_input_repair_precondition_changed");
    expect((await invoke([current], true)).repaired).toBe(0);
  } finally { db.close(); }
});


test("identity CLI repairs reviewed duplicates in a pinned rebuild and preserves serving identity", async () => {
  const { root, db, first, second, input, generationId } = await fixture("Luna", "루나", "Luna 이야기입니다.");
  try {
    for (const [id, label, source] of [["canonical", "루나", first], ["duplicate", "Luna", { source_id: input.source_units[0]!.ref, episode_id: input.episode_ref, revision: input.revision }]] as const) {
      db.query("INSERT INTO memory_nodes(id,type,label_original,identity_scope,created_at) VALUES(?,'entity',?,'user',?)").run(id, label, first.observed_at);
      db.query("INSERT INTO memory_evidence(node_id,source_id,episode_id,revision) VALUES(?,?,?,?)").run(id, source.source_id, source.episode_id, source.revision);
    }
    const canonicalStore = new AgentConversationStore({ butlerData: root });
    const canonicalRevision = canonicalStore.readPublicSourceRevision();
    canonicalStore.close();
    const prepared = prepareMemoryRebuild({ butlerData: root, sourceInventory: {}, sourceInventoryHash: "a".repeat(64), expectedCanonicalRevision: canonicalRevision,
      verifySnapshotInventory: () => ({ sourceInventory: {}, sourceInventoryHash: "a".repeat(64) }) });
    const candidateGraph = join(root, "cognition/memory/generations", prepared.generationId, "graph.sqlite");
    rmSync(candidateGraph);
    db.exec(`VACUUM INTO '${candidateGraph.replaceAll("'", "''")}'`);
    // A rebuild must read its snapshot, even when the serving source is unavailable.
    renameSync(join(root, "runtime"), join(root, "runtime-live-offline"));
    const requestPath = join(root, "identity-command.json");
    const invoke = (command: any, rebuilding = true) => {
      writeFileSync(requestPath, JSON.stringify(command));
      const result = spawnSync(process.execPath, ["run", "packages/butler-agent/src/agent/cognition/memory/scripts/consolidation-cycle.ts",
        "--memory-identity", command.operation, "--input", requestPath, ...(rebuilding ? ["--rebuild"] : [])],
      { cwd: process.cwd(), env: { ...process.env, BUTLER_DATA: root, BUTLER_HOME: process.cwd() }, encoding: "utf8" });
      return { code: result.status, value: JSON.parse((result.stdout || result.stderr).trim()) };
    };
    const inspect = { schema: "butler.memory-identity-command.v1", expected_generation: prepared.generationId,
      operation: "inspect", source_ref: second.source_id, node_refs: ["duplicate", "canonical"] };
    expect(invoke(inspect, false).code).toBe(1);
    const inspected = invoke(inspect);
    expect(inspected.code).toBe(0);
    const command = { ...inspect, operation: "apply", operation_id: "reviewed-duplicate", decision: "same_entity", reason: "reviewed_duplicate",
      review_note: "Operator compared the user name and the public response in the same conversation.",
      source: { source_ref: second.source_id, quote: "Luna", occurrence: 0 }, loser_node_ref: "duplicate", canonical_node_ref: "canonical",
      loser_evidence: { source_ref: input.source_units[0]!.ref, quote: "Luna", occurrence: 0 },
      canonical_evidence: { source_ref: first.source_id, quote: "루나", occurrence: 0 },
      expected_loser: inspected.value.states.duplicate, expected_canonical: inspected.value.states.canonical } as any;
    delete command.source_ref; delete command.node_refs;
    expect(invoke({ ...command, review_note: "" }).code).toBe(1);
    const applied = invoke(command);
    expect(applied.code).toBe(0);
    expect(applied.value.recorded_outcome).toBe("applied");
    expect(invoke(command).value.replayed).toBe(true);
    const candidate = openProjectionDb(candidateGraph);
    try {
      expect(candidate.query<{ canonical_node_id: string }, []>("SELECT canonical_node_id FROM memory_nodes WHERE id='duplicate'").get()!.canonical_node_id).toBe("canonical");
      expect(db.query<{ canonical_node_id: string | null }, []>("SELECT canonical_node_id FROM memory_nodes WHERE id='duplicate'").get()!.canonical_node_id).toBeNull();
      expect(JSON.parse(readFileSync(join(root, "cognition/memory/active-generation.json"), "utf8")).generation_id).toBe(generationId);
      expect(candidate.query<{ n: number }, []>("SELECT count(*) n FROM memory_projection_attempts").get()!.n).toBe(0);
    } finally { candidate.close(); }
  } finally { db.close(); }
}, 20_000);
