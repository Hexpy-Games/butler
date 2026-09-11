import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { initializeEmptyMemoryGeneration } from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";
import { ingestConversationMemory } from "../../packages/butler-agent/src/agent/cognition/memory/projection/ingestion.ts";
import { createContextEvidenceResolver } from "../../packages/butler-agent/src/agent/cognition/memory/projection/context-evidence.ts";
import { projectionHash } from "../../packages/butler-agent/src/agent/cognition/memory/projection/source.ts";
import { runMemoryRebuildCommand } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/consolidation-cycle.ts";
import {
  openProjectionDb,
  type ProjectionSourceRow,
} from "../../packages/butler-agent/src/agent/cognition/memory/projection/store.ts";
import type { ExtractInput } from "../../packages/butler-agent/src/agent/cognition/memory/projection/contracts.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fixture(
  secondText = "العربية 日本語 끝  ",
  firstText = "  앞말 ",
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
    text: "확인했습니다.",
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
      db.exec("BEGIN");
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
      db.query("INSERT INTO entities(id,type,label_original,identity_scope,created_at) VALUES(?,?,?,'user',?)").run(id!, type!, label!, second.observed_at);
      db.query("INSERT INTO entity_aliases(entity_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES(?,?,?,?,?,'create')").run(id!, label!, label!, label!, second.source_id);
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
    const invoke = (windows: typeof selected[], dryRun = false) => {
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
    db.query("UPDATE memory_projection_windows SET state='complete' WHERE window_ref=?").run(window.window_ref);
    await expect(invoke([current])).rejects.toThrow("memory_input_repair_precondition_changed");
    expect((await invoke([current], true)).repaired).toBe(0);
  } finally { db.close(); }
});
