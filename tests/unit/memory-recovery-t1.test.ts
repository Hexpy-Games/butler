import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import type { ProviderStreamProjectionHandler } from "../../packages/butler-agent/src/integrations/providers/runtime-contracts.ts";
import type { PromptOptions } from "../../packages/butler-agent/src/integrations/providers/runtime-contracts.ts";
import { OPENAI_PROVIDER_ADAPTER } from "../../packages/butler-agent/src/integrations/providers/openai/adapter.ts";
import { createServer } from "node:net";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { NativeInboundQueue } from "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import { computeMemoryGenerationReadiness, initializeEmptyMemoryGeneration } from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";
import { hydrateSource, memorySourceInventoryHash } from "../../packages/butler-agent/src/agent/cognition/memory/projection/source.ts";
import type { MemoryExecutionContext } from "../../packages/butler-agent/src/agent/cognition/memory/projection/contracts.ts";
import { extractOutputSchema } from "../../packages/butler-agent/src/agent/cognition/memory/projection/extractor.ts";
import { validateJsonObjectSchema } from "../../packages/butler-agent/src/agent/tools/schema-validation.ts";
import { unicodeCaseFold } from "../../packages/butler-agent/src/agent/cognition/memory/projection/unicode.ts";
import { openProjectionDb, progressFromDb } from "../../packages/butler-agent/src/agent/cognition/memory/projection/store.ts";
import { normalizeAndValidatePlan } from "../../packages/butler-agent/src/agent/cognition/memory/projection/plan.ts";
import { publishConversationCompletionObservation } from "../../packages/butler-agent/src/agent/cognition/continuity/completion-observation.ts";
import { PromptAssembler } from "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import { peek } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/queue.ts";
import { createToolCallToolHandler } from "../../packages/butler-agent/src/agent/tools/tool-bridge/tool_call/executor.ts";
import { recallMemoryToolDefinition } from "../../packages/butler-agent/src/agent/tools/memory/recall_memory/definition.ts";
import { expandGraph } from "../../packages/butler-agent/src/agent/cognition/memory/recall/graph.ts";
import {
  assertAllocatedProjectionState,
  failedVectorUnits,
  runMemoryRecoveryDispatcherHarness,
} from "../e2e/memory-recovery-multilingual-live-e2e.ts";
import {
  acquireConsolidationLock,
  acquireConsolidationLockAsync,
  consolidationLockPath,
  inspectConsolidationLock,
  releaseConsolidationLock,
  sweepStaleLocks,
} from "../../packages/butler-agent/src/agent/cognition/memory/scripts/lib/lock.ts";

const roots: string[] = [];

function writeT6OwnerEvidence(name: string, value: unknown): void {
  const root = process.env.BUTLER_MEMORY_RECOVERY_EVIDENCE_DIR?.trim();
  if (!root) return;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, name), `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
let extractionInputs: Array<Record<string, any>> = [];
let extractionRequests: Array<{
  instructions: string;
  responseFormat: { schema: Record<string, unknown> };
}> = [];
let duringExtraction: (() => void) | null = null;
let duringProviderAwait: ((signal: AbortSignal, observe?: ProviderStreamProjectionHandler) => Promise<void>) | null = null;
let extractionFailure: ((input: Record<string, any>) => Error | null) | null =
  null;
let transformExtractionOutput:
  | ((output: Record<string, any>, input: Record<string, any>) => void)
  | null = null;

const originalOpenAiRunPrompt = OPENAI_PROVIDER_ADAPTER.runPrompt;
OPENAI_PROVIDER_ADAPTER.runPrompt = async (request: PromptOptions) => {
      expect(request.providerRetryAttempts).toBe(0);
      const input = JSON.parse(request.prompt) as Record<string, any>;
      extractionInputs.push(input);
      extractionRequests.push({
        instructions: request.instructions ?? "",
        responseFormat: request.responseFormat!,
      });
      duringExtraction?.();
      if (duringProviderAwait) {
        if (!request.signal) throw new Error("test extractor request is missing its runtime signal");
        await duringProviderAwait(request.signal, request.onProviderStreamEvent);
      }
      const failure = extractionFailure?.(input);
      if (failure) throw failure;
      const output = extractFor(input);
      transformExtractionOutput?.(output, input);
      const model = request.model ?? "openai/gpt-5.6-sol";
      return {
        text: JSON.stringify(output),
        model,
        usage: {
          model,
          promptTokens: 100,
          cachedTokens: 0,
          outputTokens: 50,
          totalTokens: 150,
        },
      };
};

afterAll(() => {
  OPENAI_PROVIDER_ADAPTER.runPrompt = originalOpenAiRunPrompt;
});

afterEach(() => {
  extractionInputs = [];
  extractionRequests = [];
  duringExtraction = null;
  duringProviderAwait = null;
  extractionFailure = null;
  transformExtractionOutput = null;
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }));
});

test("normal App target waits past prior reconciliation and binds admitted canonical bytes", async () => {
  const dataRoot = process.env.BUTLER_DATA ?? "";
  expect(dataRoot).toBeTruthy();
  expect(existsSync(dataRoot)).toBe(false);
  roots.push(dataRoot);
  try {
    const result = await runMemoryRecoveryDispatcherHarness(dataRoot);
    expect(result).toMatchObject({
      ok: true,
      unrelatedModelCalls: 1,
    });
    expect(result.unrelatedHandled).toBeGreaterThanOrEqual(1);
    expect(result.requestBytes).toBe(result.admittedBytes + 1);
    expect(result.requestSha256).not.toBe(result.admittedSha256);
    expect(result.canonicalTurnId).toBeTruthy();
    expect(result.canonicalRequestMessageId).toBeTruthy();
    const canonicalPath = join(dataRoot, "runtime", "conversation-store.sqlite");
    const canonical = new Database(canonicalPath);
    const assistant = canonical.query<{ id: string }, [string]>(
      "SELECT id FROM conversation_messages WHERE turn_id=? AND role='assistant' ORDER BY seq DESC LIMIT 1",
    ).get(result.canonicalTurnId);
    expect(assistant?.id).toBeTruthy();
    canonical.query(`UPDATE conversation_messages
      SET origin_kind='unknown',origin_ref=NULL,origin_reason=NULL,origin_version=NULL,origin_evidence_json=NULL
      WHERE id IN (?,?)`).run(result.canonicalRequestMessageId, assistant!.id);
    canonical.close();

    const legacyStore = new AgentConversationStore({ butlerData: dataRoot });
    const legacyTurn = legacyStore.beginTurn({
      gateway: "app", externalSessionId: "legacy-null-request-session",
      sessionId: "legacy-null-request-session", actor: "assistant",
      turnId: "legacy-null-request-turn",
    });
    const legacyAssistant = legacyStore.appendAssistantMessage({
      sessionId: legacyTurn.session_id, turnId: legacyTurn.id,
      text: "Legacy assistant without a request reference.", originKind: "unknown",
    });
    const designatedPublicAssistant = legacyStore.appendAssistantMessage({
      sessionId: legacyTurn.session_id, turnId: legacyTurn.id,
      text: "Different designated public assistant.", originKind: "unknown",
    });
    legacyStore.finalizeTurn({
      turnId: legacyTurn.id, status: "complete",
      outcomeCapsule: {
        sessionId: legacyTurn.session_id, turnId: legacyTurn.id, generation: 1,
        outcome: "delivered", requestMessageId: null,
        publicAssistantMessageId: designatedPublicAssistant.id,
      },
    });
    legacyStore.close();

    const { runMemoryRebuildCommand } = await import(
      "../../packages/butler-agent/src/agent/cognition/memory/scripts/consolidation-cycle.ts"
    );
    const prepared = await runMemoryRebuildCommand({
      butlerData: dataRoot,
      argv: ["--memory-rebuild", "prepare"],
      signal: new AbortController().signal,
    });
    expect(prepared.operation).toBe("prepare");
    const classified = new Database(canonicalPath, { readonly: true });
    const rows = classified.query<{
      id: string; origin_kind: string; origin_version: string | null; origin_evidence_json: string | null;
    }, [string, string]>(`SELECT id,origin_kind,origin_version,origin_evidence_json
      FROM conversation_messages WHERE id IN (?,?) ORDER BY role`).all(
        result.canonicalRequestMessageId, assistant!.id,
      );
    classified.close();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === result.canonicalRequestMessageId)).toMatchObject({
      origin_kind: "user_input", origin_version: "conversation-origin-v1",
    });
    const publicAssistant = rows.find((row) => row.id === assistant!.id);
    expect(publicAssistant).toMatchObject({
      origin_kind: "assistant_public", origin_version: "conversation-origin-v1",
    });
    expect(JSON.parse(publicAssistant!.origin_evidence_json ?? "[]").length).toBeGreaterThan(0);
    const legacyClassified = new Database(canonicalPath, { readonly: true });
    const legacyRow = legacyClassified.query<{
      origin_kind: string; origin_reason: string | null; origin_version: string | null;
    }, [string]>(`SELECT origin_kind,origin_reason,origin_version FROM conversation_messages WHERE id=?`)
      .get(legacyAssistant.id);
    legacyClassified.close();
    expect(legacyRow).toEqual({
      origin_kind: "unknown",
      origin_reason: "historical_origin_unresolved",
      origin_version: "conversation-origin-v1",
    });
    const descriptor = JSON.parse(readFileSync(join(dataRoot, "cognition", "memory", "active-generation.json"), "utf8"));
    const { createLazyConversationProjectionReader } = await import(
      "../../packages/butler-agent/src/agent/conversation/projection-reader-store.ts"
    );
    const { decodeMessageScalars } = await import(
      "../../packages/butler-agent/src/agent/cognition/memory/projection/source.ts"
    );
    const reader = createLazyConversationProjectionReader({ butlerData: dataRoot });
    const canonicalMessages = [result.canonicalRequestMessageId, assistant!.id].map((messageId) => {
      const message = reader.readMessageById(messageId);
      expect(message).toBeTruthy();
      return {
        message_id: message!.id,
        session_id: message!.session_id,
        turn_id: message!.turn_id,
        role: message!.role,
        origin_kind: message!.origin_kind,
        scalars: decodeMessageScalars(message!).map((scalar) => ({
          part_id: scalar.part.id,
          scalar_pointer: scalar.pointer,
          text: scalar.text,
          bytes: Buffer.byteLength(scalar.text, "utf8"),
          sha256: scalar.hash,
        })),
      };
    });
    reader.close();
    const implementationSourcePath = join(
      process.cwd(), "packages", "butler-agent", "src", "agent", "cognition", "memory", "scripts", "consolidation-cycle.ts",
    );
    writeT6OwnerEvidence("t6-b-app-owner-result.json", {
      schema: "butler.memory-owner-result-evidence.v1",
      result_id: `app-origin:${result.canonicalTurnId}`,
      generation_id: descriptor.generation_id,
      status: "ok",
      source_handles: [],
      observations: [{ kind: "session_message", message_id: result.canonicalRequestMessageId }],
      raw_facts: {
        canonical_turn_id: result.canonicalTurnId,
        canonical_request_message_id: result.canonicalRequestMessageId,
        canonical_session_id: result.canonicalSessionId,
        runtime_session_id: result.runtimeSessionId,
        request_sha256: result.requestSha256,
        admitted_sha256: result.admittedSha256,
        origin: rows,
      },
      implementation_source_file: {
        path: "packages/butler-agent/src/agent/cognition/memory/scripts/consolidation-cycle.ts",
        sha256: createHash("sha256").update(readFileSync(implementationSourcePath)).digest("hex"),
      },
    });
    writeT6OwnerEvidence("t6-b-app-source-facts.json", {
      canonical_session_id: result.canonicalSessionId,
      runtime_session_id: result.runtimeSessionId,
      canonical_turn_id: result.canonicalTurnId,
      messages: canonicalMessages,
      origins: rows,
    });
  } catch (error) {
    const index = roots.indexOf(dataRoot);
    if (index >= 0) roots.splice(index, 1);
    console.error(`T3_TARGET_FAILED_ROOT=${dataRoot}`);
    throw error;
  }
}, 15_000);

test("official Unicode casefold and strict nested extraction schema", () => {
  expect(unicodeCaseFold("\uFB05 Straße Σς")).toBe("st strasse σσ");
  const schema = extractOutputSchema();
  const schemaText = JSON.stringify(schema);
  expect(schemaText).toContain("The 0-based matching occurrence");
  expect(schemaText).toContain("source_units.ref, context_units.ref");
  const invalid = extractFor({
    window_ref: "w",
    source_units: [{ ref: "s", text: "Luna" }],
    candidates: [],
  });
  invalid.nodes[0]!.resolution.extra = true;
  expect(validateJsonObjectSchema(invalid, extractOutputSchema()).ok).toBe(
    false,
  );
  const bounded = extractFor({
    window_ref: "w",
    source_units: [{ ref: "s", text: "Luna" }],
    candidates: [],
  });
  bounded.nodes[0]!.aliases = Array.from({ length: 9 }, (_, index) => ({
    text: `alias-${index}`,
    evidence: [{ unit_ref: "s", quote: "Luna", occurrence: 0 }],
  }));
  expect(validateJsonObjectSchema(bounded, extractOutputSchema()).ok).toBe(
    false,
  );
  const emptyEvidence = extractFor({
    window_ref: "w",
    source_units: [{ ref: "s", text: "Luna" }],
    candidates: [],
  });
  emptyEvidence.nodes[0]!.evidence = [];
  expect(validateJsonObjectSchema(emptyEvidence, schema).ok).toBe(false);
  const longText = "x".repeat(481);
  const longSummary = {
    schema: "butler.memory-extract-output.v2",
    window_ref: "long",
    disposition: "processed",
    covered_unit_refs: ["source"],
    nodes: [],
    claims: [],
    relations: [],
    corrections: [],
    summary: {
      text: longText,
      evidence: [{ unit_ref: "source", quote: longText, occurrence: 0 }],
    },
  };
  expect(validateJsonObjectSchema(longSummary, extractOutputSchema()).ok).toBe(
    true,
  );
  expect(() =>
    normalizeAndValidatePlan(
      null as never,
      {
        schema: "butler.memory-extract-input.v2",
        episode_ref: "episode",
        revision: "revision",
        window_ref: "long",
        source_units: [
          {
            ref: "source",
            role: "user",
            text: longText,
            observed_at: "2026-09-08T00:00:00.000Z",
            origin_kind: "user_input",
          },
        ],
        context_units: [],
        candidates: [],
        bound_project_id: null,
      },
      longSummary as never,
    ),
  ).toThrow("memory_extract_invalid_output");

  const combining = "e\u0301".repeat(256);
  const combiningOutput = {
    schema: "butler.memory-extract-output.v2",
    window_ref: "combining",
    disposition: "processed",
    covered_unit_refs: ["source"],
    nodes: [],
    claims: [],
    relations: [],
    corrections: [],
    summary: {
      text: combining,
      evidence: [{ unit_ref: "source", quote: combining, occurrence: 0 }],
    },
  };
  expect(
    validateJsonObjectSchema(combiningOutput, extractOutputSchema()).ok,
  ).toBe(true);
  expect(() =>
    normalizeAndValidatePlan(
      null as never,
      {
        schema: "butler.memory-extract-input.v2",
        episode_ref: "episode",
        revision: "revision",
        window_ref: "combining",
        source_units: [
          {
            ref: "source",
            role: "user",
            text: combining,
            observed_at: "2026-09-08T00:00:00.000Z",
            origin_kind: "user_input",
          },
        ],
        context_units: [],
        candidates: [],
        bound_project_id: null,
      },
      combiningOutput as never,
    ),
  ).not.toThrow();
});

test("short unit references preserve canonical ingestion and reject unknown or expanded output", async () => {
  const memory = await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  for (const mode of ["valid", "unknown", "expanded"] as const) {
    const butlerData = mkdtempSync(join(tmpdir(), "memory-short-refs-"));
    roots.push(butlerData);
    const descriptor = initializeEmptyMemoryGeneration(butlerData);
    const context = { butlerData, target: { kind: "active" as const, expected_generation: descriptor.generation_id }, signal: new AbortController().signal };
    transformExtractionOutput = (output, input) => {
      expect(input.source_units.map((unit: any) => unit.ref)).toEqual(["u0", "u1"]);
      expect(input.source_units[0].text).toBe("내 고양이 루나의 영어 이름은 Luna야. u0 العربية 日本語");
      if (mode === "valid") output.summary = { text: "u0 العربية 日本語", evidence: [{ unit_ref: "u0", quote: "u0 العربية 日本語", occurrence: 0 }] };
      if (mode === "unknown") output.nodes[0].evidence[0].unit_ref = "missing-unit";
      if (mode === "expanded") {
        const node = output.nodes[0];
        output.nodes = Array.from({ length: 32 }, (_, index) => ({ ...node, local_ref: `n${index}`,
          aliases: Array.from({ length: 4 }, () => ({ text: "Luna", evidence: Array.from({ length: 4 }, () => ({ unit_ref: "u0", quote: "Luna", occurrence: 0 })) })),
        }));
        output.claims = []; output.relations = []; output.corrections = []; output.summary = null;
        expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(65_536);
      }
    };
    await memory.ingestConversationMemory({ context, source: seedTurn(butlerData, "short-ref", "short-ref-turn",
      "내 고양이 루나의 영어 이름은 Luna야. u0 العربية 日本語", "Noted.", 1) });
    await memory.advanceNextMemoryProjection({ context });
    const db = new Database(join(butlerData, "cognition/memory/generations", descriptor.generation_id, "graph.sqlite"), { readonly: true });
    try {
      const row = db.query<any, []>("SELECT * FROM memory_projection_windows").get();
      const canonical = JSON.parse(row.input_json);
      const wire = extractionInputs.at(-1)!;
      expect(wire.source_units.map((unit: any) => unit.text)).toEqual(canonical.source_units.map((unit: any) => unit.text));
      expect(canonical.source_units[0].ref).not.toBe("u0");
      expect(JSON.parse(row.provider_evidence_json).request_wire).toEqual({
        profile: "memory-extract-short-refs.v2",
        input_json_sha256: createHash("sha256").update(JSON.stringify(wire)).digest("hex"),
        input_json_utf8_bytes: Buffer.byteLength(JSON.stringify(wire)),
      });
      if (mode === "valid") {
        expect(row.state).toBe("complete");
        const output = JSON.parse(row.output_json);
        expect(output.covered_unit_refs).toEqual(canonical.source_units.map((unit: any) => unit.ref));
        expect(output.summary.text).toBe("u0 العربية 日本語");
        expect(output.summary.evidence[0]).toEqual({ unit_ref: canonical.source_units[0].ref, quote: "u0 العربية 日本語", occurrence: 0 });
        expect(row.normalized_plan_json).not.toBeNull();
      } else {
        expect(row.error_code).toBe(mode === "unknown" ? "memory_extract_invalid_output" : "extraction_budget_exceeded");
        expect(row.normalized_plan_json).toBeNull();
        expect(db.query<any, []>("SELECT COUNT(*) n FROM entities WHERE type!='episode'").get().n).toBe(0);
      }
    } finally { db.close(); }
  }
});

test("shape-valid invalid quote preserves provider evidence before plan rejection", async () => {
  const butlerData = mkdtempSync(
    join(tmpdir(), "butler-memory-invalid-quote-"),
  );
  roots.push(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const memory =
    await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  const context = {
    butlerData,
    target: {
      kind: "active" as const,
      expected_generation: descriptor.generation_id,
    },
    signal: new AbortController().signal,
  };
  transformExtractionOutput = (output) => {
    output.nodes[0].evidence[0].quote = "not present in either source unit";
  };
  await memory.ingestConversationMemory({
    context,
    source: seedTurn(
      butlerData,
      "invalid-quote-session",
      "invalid-quote-turn",
      "내 고양이 루나의 영어 이름은 Luna야.",
      "Noted.",
      1,
    ),
  });
  const progress = await memory.advanceNextMemoryProjection({ context });
  expect(progress?.source.state).toBe("complete");
  expect(progress?.semantic_graph.state).toBe("pending");

  const graph = new Database(
    join(
      butlerData,
      "cognition",
      "memory",
      "generations",
      descriptor.generation_id,
      "graph.sqlite",
    ),
    { readonly: true },
  );
  try {
    const row = graph
      .query<
        {
          output_json: string | null;
          normalized_plan_json: string | null;
          provider_evidence_json: string | null;
          state: string;
          error_code: string | null;
        },
        []
      >(
        "SELECT output_json,normalized_plan_json,provider_evidence_json,state,error_code FROM memory_projection_windows",
      )
      .get()!;
    expect(row.state).toBe("pending");
    expect(row.error_code).toBe("memory_extract_invalid_quote");
    expect(row.output_json).not.toBeNull();
    expect(JSON.parse(row.output_json!).nodes[0].evidence[0].quote).toBe(
      "not present in either source unit",
    );
    expect(row.normalized_plan_json).toBeNull();
    const evidence = JSON.parse(row.provider_evidence_json!);
    expect(evidence.reported_model).toBeTruthy();
    expect(evidence.usage).toMatchObject({
      prompt_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    });
    expect(evidence.duration_ms).toBeGreaterThanOrEqual(0);
    expect(
      graph
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) count FROM memory_projection_attempts WHERE state='failed' AND error_code='memory_extract_invalid_quote'")
        .get()!.count,
    ).toBe(1);
    expect(
      graph
        .query<{ rows: number; invocations: number }, []>(
          `
      SELECT COUNT(*) rows,COUNT(DISTINCT invocation_ref) invocations FROM memory_projection_attempts WHERE attempt_count=1
    `,
        )
        .get(),
    ).toEqual({ rows: 2, invocations: 1 });
  } finally {
    graph.close();
  }
  const graphPath = join(
    butlerData,
    "cognition",
    "memory",
    "generations",
    descriptor.generation_id,
    "graph.sqlite",
  );
  for (let retry = 0; retry < 2; retry += 1) {
    if (retry === 0) {
      let throwOnce = true;
      extractionFailure = () => {
        if (!throwOnce) return null;
        throwOnce = false;
        extractionFailure = null;
        return new Error("memory_extract_provider_failed");
      };
    }
    const writable = new Database(graphPath);
    writable
      .query(
        "UPDATE memory_projection_windows SET next_attempt_at='2000-01-01T00:00:00Z'",
      )
      .run();
    writable
      .query("UPDATE memory_projection_jobs SET next_stage='semantic_graph'")
      .run();
    writable.close();
    await memory.advanceNextMemoryProjection({ context });
    if (retry === 0) {
      const current = new Database(graphPath, { readonly: true });
      try {
        const window = current.query<any, []>("SELECT output_json,provider_evidence_json FROM memory_projection_windows").get();
        const attempt = current.query<any, []>("SELECT provider_evidence_json FROM memory_projection_attempts WHERE attempt_count=2 AND state='failed'").get();
        expect(window.output_json).toBeNull();
        expect(window.provider_evidence_json).toBe(attempt.provider_evidence_json);
        expect(JSON.parse(window.provider_evidence_json)).toMatchObject({ failure_kind: "before_result", usage: null, reported_model: null, remote_outcome: null });
        const prior = current.query<any, []>("SELECT output_json,provider_evidence_json FROM memory_projection_attempts WHERE attempt_count=1 AND state='provider_result'").get();
        expect(prior.output_json).not.toBeNull();
        expect(JSON.parse(prior.provider_evidence_json).usage).not.toBeNull();
      } finally { current.close(); }
    }
  }
  expect(extractionInputs).toHaveLength(3);
  expect(extractionInputs[1]).toEqual(extractionInputs[0]);
  expect(extractionInputs[2]).toEqual(extractionInputs[0]);
  const terminal = new Database(graphPath, { readonly: true });
  expect(
    terminal
      .query<
        { state: string; attempt_count: number },
        []
      >("SELECT state,attempt_count FROM memory_projection_windows")
      .get(),
  ).toEqual({ state: "failed", attempt_count: 3 });
  expect(
    terminal
      .query<
        { count: number },
        []
      >("SELECT COUNT(*) count FROM memory_projection_attempts WHERE state='failed' AND error_code='memory_extract_invalid_quote'")
      .get()!.count,
  ).toBe(2);
  const rejectedAttempt = terminal.query<{ output_json: string | null; provider_evidence_json: string; provider_invoked: number }, []>(
    "SELECT output_json,provider_evidence_json,provider_invoked FROM memory_projection_attempts WHERE attempt_count=2 AND state='failed'",
  ).get()!;
  expect(rejectedAttempt).toMatchObject({ output_json: null, provider_invoked: 1 });
  expect(JSON.parse(rejectedAttempt.provider_evidence_json)).toMatchObject({
    failure_kind: "before_result", usage: null, reported_model: null, remote_outcome: null,
  });
  expect(
    terminal
      .query<{ invocations: number }, []>(
        `
    SELECT COUNT(DISTINCT invocation_ref) invocations FROM memory_projection_attempts WHERE provider_invoked=1
  `,
      )
      .get(),
  ).toEqual({ invocations: 3 });
  terminal.close();

  const interruptedData = mkdtempSync(
    join(tmpdir(), "butler-memory-dead-third-"),
  );
  roots.push(interruptedData);
  const interruptedDescriptor =
    initializeEmptyMemoryGeneration(interruptedData);
  const interruptedContext = {
    butlerData: interruptedData,
    target: {
      kind: "active" as const,
      expected_generation: interruptedDescriptor.generation_id,
    },
    signal: new AbortController().signal,
  };
  const interrupted = await memory.ingestConversationMemory({
    context: interruptedContext,
    source: seedTurn(
      interruptedData,
      "dead-third-session",
      "dead-third-turn",
      "Luna third attempt",
      "Noted.",
      1,
    ),
  });
  const interruptedGraph = join(
    interruptedData,
    "cognition",
    "memory",
    "generations",
    interruptedDescriptor.generation_id,
    "graph.sqlite",
  );
  const dead = new Database(interruptedGraph);
  dead
    .query(
      "UPDATE memory_projection_windows SET state='running',attempt_count=3,owner_pid=999999,owner_nonce='dead-third',started_at='2026-09-08T00:00:00Z' WHERE job_id=?",
    )
    .run(interrupted.job_id);
  dead.close();
  const callsBeforeRecovery = extractionInputs.length;
  const recoveredProgress = await memory.advanceNextMemoryProjection({
    context: interruptedContext,
  });
  expect(recoveredProgress?.semantic_graph).toMatchObject({
    state: "partial",
    pending_units: 0,
    failed_units: 1,
  });
  expect(extractionInputs).toHaveLength(callsBeforeRecovery);
  const recovered = new Database(interruptedGraph, { readonly: true });
  expect(
    recovered
      .query<
        { state: string; attempt_count: number; error_code: string },
        [string]
      >("SELECT state,attempt_count,error_code FROM memory_projection_windows WHERE job_id=?")
      .get(interrupted.job_id),
  ).toEqual({
    state: "failed",
    attempt_count: 3,
    error_code: "memory_projection_attempts_exhausted",
  });
  expect(
    recovered
      .query<
        { n: number },
        []
      >("SELECT COUNT(*) n FROM memory_projection_attempts WHERE state='interrupted' AND outcome_known=0")
      .get(),
  ).toEqual({ n: 1 });
  recovered.close();
});

test.each(["small", "mixed", "dense"])("local extraction timeout preserves history and bounded recovery: %s", async (mode) => {
  const butlerData = mkdtempSync(join(tmpdir(), "memory-c08-"));
  roots.push(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const memory = await import("../../packages/butler-agent/src/agent/cognition/memory/projection/ingestion.ts");
  const context = { butlerData, target: { kind: "active" as const, expected_generation: descriptor.generation_id }, signal: new AbortController().signal };
  const graphPath = join(butlerData, "cognition/memory/generations", descriptor.generation_id, "graph.sqlite");
  const success = await memory.ingestConversationMemory({ context,
    source: seedTurn(butlerData, "c08-ok", "c08-ok-turn", "내 고양이 루나의 영어 이름은 Luna야.", "Noted.", 1) });
  await memory.advanceNextMemoryProjection({ context });
  const db = new Database(graphPath);
  const completed = db.query<any, [string]>("SELECT * FROM memory_projection_windows WHERE job_id=?").get(success.job_id);
  expect(completed.state).toBe("complete");
  const failedText = mode === "dense" ? "Luna ".repeat(256) : "Luna likes the blue ball.";
  const failed = await memory.ingestConversationMemory({ context,
    source: seedTurn(butlerData, "c08-fail", "c08-fail-turn", failedText, "Noted.", 1) });
  const window = () => db.query<any, [string]>("SELECT * FROM memory_projection_windows WHERE job_id=?").get(failed.job_id);
  const due = () => {
    db.query("UPDATE memory_projection_windows SET next_attempt_at='2000-01-01T00:00:00Z' WHERE job_id=? AND state IN ('pending','planned')").run(failed.job_id);
    db.query("UPDATE memory_projection_jobs SET next_stage='semantic_graph',last_served_at=NULL WHERE job_id=?").run(failed.job_id);
  };
  const originalTimer = globalThis.setTimeout;
  let fireTimeout: (() => void) | null = null;
  globalThis.setTimeout = ((handler: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay === 180_000) fireTimeout = () => handler(...args);
    return originalTimer(handler, delay, ...args);
  }) as typeof setTimeout;
  const { ModelProviderRequestError } = await import("../../packages/butler-agent/src/integrations/providers/provider-request-errors.ts");
  let providerAttempt = 0;
  duringProviderAwait = async (signal, observe) => {
    providerAttempt += 1;
    if (mode === "mixed" && providerAttempt === 2) throw new ModelProviderRequestError({ code: "provider_busy", statusCode: 503, retryable: true, message: "private provider body" });
    if (mode === "small") {
      await observe?.({ type: "reasoning_delta", textDelta: "private reasoning" });
      await observe?.({ type: "tool_call_delta", callIndex: 0, argumentsDelta: "private arguments" });
      await observe?.({ type: "text_delta", target: "final_candidate", textDelta: "{\"이름\":", raw: "private raw" });
      await observe?.({ type: "text_delta", target: "final_candidate", textDelta: "\"루나\"}" });
    } else if (mode === "mixed") {
      await observe?.({ type: "completed", status: "completed" });
    }
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("Runtime turn was cancelled."), { name: "AbortError" })), { once: true });
      expect(fireTimeout).not.toBeNull();
      fireTimeout!();
    });
  };
  try {
    let pinned: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      due();
      const before = Date.now();
      await memory.advanceNextMemoryProjection({ context });
      const row = window();
      expect(row).toMatchObject({ attempt_count: attempt, recovery_revision: null, recovery_base_attempt_count: 0,
        error_code: mode === "dense" && attempt === 3 ? "memory_extract_timeout_split" : mode === "mixed" && attempt === 2 ? "memory_extract_provider_failed" : "memory_extract_timeout",
        state: attempt < 3 ? "pending" : mode === "dense" ? "replaced" : "failed" });
      if (attempt < 3) expect(Date.parse(row.next_attempt_at) - before).toBeGreaterThanOrEqual(attempt === 1 ? 30_000 : 120_000);
      else expect(row.next_attempt_at).toBeNull();
      if (pinned === null) pinned = row.input_json;
      expect(row.input_json).toBe(pinned);
      const evidence = JSON.parse(row.provider_evidence_json);
      const requestJson = JSON.stringify(extractionInputs.at(-1));
      expect(evidence.request_wire).toEqual({ profile: "memory-extract-short-refs.v2",
        input_json_sha256: createHash("sha256").update(requestJson).digest("hex"), input_json_utf8_bytes: Buffer.byteLength(requestJson) });
      if (mode === "mixed" && attempt === 2) expect(evidence).toMatchObject({ provider_code: "provider_busy", upstream_status: 503, timeout_origin: "unknown" });
      else expect(evidence).toMatchObject({ failure_kind: "before_result", code: "memory_extract_timeout", exception_name: "AbortError",
        timeout_origin: "local", usage: null, upstream_status: null, reported_model: null, remote_outcome: null });
      expect(evidence.local_elapsed_ms).toBeGreaterThanOrEqual(0);
      expect(evidence.visible_stream).toMatchObject(mode === "small" ? {
        observation_status: "visible_output_observed", visible_delta_events: 2,
        visible_utf8_bytes: Buffer.byteLength('{"이름":"루나"}'), completed_event_observed: false,
      } : mode === "mixed" && attempt !== 2 ? {
        observation_status: "stream_completion_observed", first_visible_delta_ms: null,
        visible_delta_events: 0, visible_utf8_bytes: 0, completed_event_observed: true,
      } : {
        observation_status: "no_visible_stream_observation", first_visible_delta_ms: null,
        visible_delta_events: null, visible_utf8_bytes: null, completed_event_observed: false,
      });
      if (mode === "small") expect(evidence.visible_stream.first_visible_delta_ms).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(evidence)).not.toContain("private");
      expect(JSON.stringify(evidence)).not.toContain("루나");
      expect(JSON.stringify(evidence)).not.toContain("Runtime turn was cancelled");
    }
    if (mode === "dense") {
      const parent = window();
      const originalFailures = db.query<any, [string]>("SELECT * FROM memory_projection_attempts WHERE job_id=? AND state='failed' ORDER BY attempt_ref").all(failed.job_id);
      expect(originalFailures).toHaveLength(3);
      expect(originalFailures.every((row) => row.error_code === "memory_extract_timeout" && row.output_json === null)).toBe(true);
      const children = db.query<any, [string]>("SELECT * FROM memory_projection_windows WHERE parent_window_ref=? ORDER BY ordinal").all(parent.window_ref);
      expect(children).toHaveLength(2);
      expect(children.every((row) => row.state === "pending" && row.attempt_count === 0 && row.recovery_base_attempt_count === 0 && row.recovery_revision === null)).toBe(true);
      const calls = extractionInputs.length;
      duringProviderAwait = null;
      transformExtractionOutput = (output) => { output.nodes = []; output.claims = []; output.relations = []; output.summary = null; };
      for (let child = 0; child < 2; child += 1) { due(); await memory.advanceNextMemoryProjection({ context }); }
      const inputs = extractionInputs.slice(calls);
      expect(inputs).toHaveLength(2);
      expect(inputs.flatMap((input) => input.source_units.filter((unit: any) => unit.role === "user").map((unit: any) => unit.text)).join("")).toBe(failedText);
      expect(inputs.every((input) => input.source_units.reduce((sum: number, unit: any) => sum + Buffer.byteLength(unit.text), 0) >= 512)).toBe(true);
      expect(db.query<any, [string]>("SELECT * FROM memory_projection_windows WHERE parent_window_ref=? ORDER BY ordinal").all(parent.window_ref).every((row) => row.state === "complete" && row.attempt_count === 1)).toBe(true);
      expect(window()).toEqual(parent);
      expect(db.query<any, [string]>("SELECT * FROM memory_projection_attempts WHERE job_id=? AND state='failed' ORDER BY attempt_ref").all(failed.job_id)).toEqual(originalFailures);
      expect(db.query<any, [string]>("SELECT * FROM memory_projection_windows WHERE job_id=?").get(success.job_id)).toEqual(completed);
      return;
    }
    const { claimNextProjectionWindow } = await import("../../packages/butler-agent/src/agent/cognition/memory/projection/store.ts");
    expect(claimNextProjectionWindow(db, { jobId: failed.job_id })).toBeNull();
    const failedRows = db.query<any, [string]>("SELECT * FROM memory_projection_attempts WHERE job_id=? ORDER BY attempt_ref").all(failed.job_id);
    expect(failedRows).toHaveLength(3);
    expect(new Set(failedRows.map((row) => row.invocation_ref)).size).toBe(3);
    const current = window();
    const job = db.query<any, [string]>("SELECT * FROM memory_projection_jobs WHERE job_id=?").get(failed.job_id);
    const request = { schema: "butler.memory.window-reprocess.v1", operation_id: "c08-explicit-recovery",
      expected_generation: descriptor.generation_id, job_id: failed.job_id, window_ref: current.window_ref,
      expected_source_revision: job.revision, expected_recovery_revision: null, expected_attempt_count: 3,
      expected_failed_attempt_ref: failedRows.find((row) => row.attempt_count === 3).attempt_ref,
      expected_error_code: current.error_code, expected_input_sha256: current.input_sha256,
      expected_model: job.extraction_model, expected_reasoning_effort: job.reasoning_effort };
    const beforeMismatch = JSON.stringify(window());
    for (const mismatch of [ { expected_generation: "wrong-generation" }, { expected_source_revision: "wrong-source" }, { expected_input_sha256: "0".repeat(64) } ]) {
      expect(() => memory.reprocessMemoryProjectionWindow({ context, request: { ...request, ...mismatch } })).toThrow();
      expect(JSON.stringify(window())).toBe(beforeMismatch);
    }
    const requestPath = join(butlerData, "reprocess.json");
    writeFileSync(requestPath, JSON.stringify(request));
    const cli = () => {
      const result = Bun.spawnSync([process.execPath, "run", "packages/butler-agent/src/agent/cognition/memory/scripts/consolidation-cycle.ts", "--memory-reprocess-window", "--input", requestPath], {
        cwd: process.cwd(), env: { ...process.env, BUTLER_DATA: butlerData }, stdout: "pipe", stderr: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return JSON.parse(result.stdout.toString().trim());
    };
    const calls = extractionInputs.length;
    const receipt = cli();
    expect(receipt).toMatchObject({ ok: true, action: "retry", state: "pending", cumulative_attempt_count: 3, recovery_attempt_count: 0, budget: 3, replayed: false });
    expect(window().recovery_base_attempt_count).toBe(3);
    expect(db.query<any, [string]>("SELECT COUNT(*) n FROM memory_projection_windows WHERE parent_window_ref=?").get(current.window_ref).n).toBe(0);
    expect(extractionInputs).toHaveLength(calls);
    expect(window().input_json).toBe(pinned);
    duringProviderAwait = null;
    due();
    await memory.advanceNextMemoryProjection({ context });
    expect(window()).toMatchObject({ state: "complete", attempt_count: 4, recovery_base_attempt_count: 3, recovery_revision: receipt.recovery_revision });
    expect(window().input_json).toBe(pinned);
    expect(extractionInputs).toHaveLength(calls + 1);
    expect(db.query<any, [string]>("SELECT * FROM memory_projection_windows WHERE job_id=?").get(success.job_id)).toEqual(completed);
    const oldRows = db.query<any, [string]>("SELECT * FROM memory_projection_attempts WHERE job_id=? AND state='failed' ORDER BY attempt_ref").all(failed.job_id);
    expect(oldRows).toEqual(failedRows);
    const afterSuccess = JSON.stringify(window());
    const attemptCount = db.query<any, []>("SELECT COUNT(*) n FROM memory_projection_attempts").get().n;
    expect(cli()).toMatchObject({ replayed: true, recovery_attempt_count: 1, cumulative_attempt_count: 4, state: "complete" });
    expect(JSON.stringify(window())).toBe(afterSuccess);
    expect(db.query<any, []>("SELECT COUNT(*) n FROM memory_projection_attempts").get().n).toBe(attemptCount);
    expect(extractionInputs).toHaveLength(calls + 1);
    expect(() => memory.reprocessMemoryProjectionWindow({ context, request: { ...request, window_ref: "different-window" } })).toThrow("memory_reprocess_operation_conflict");
  } finally {
    duringProviderAwait = null;
    globalThis.setTimeout = originalTimer;
    db.close();
  }
});

test("external cancellation remains terminal when the local extraction deadline follows", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "memory-c08-cancel-"));
  roots.push(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const memory = await import("../../packages/butler-agent/src/agent/cognition/memory/projection/ingestion.ts");
  const external = new AbortController();
  const context = { butlerData, target: { kind: "active" as const, expected_generation: descriptor.generation_id }, signal: external.signal };
  await memory.ingestConversationMemory({ context, source: seedTurn(butlerData, "cancel-session", "cancel-turn", "Luna likes the blue ball.", "Noted.", 1) });
  const originalTimer = globalThis.setTimeout;
  let fireTimeout: (() => void) | null = null;
  globalThis.setTimeout = ((handler: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay === 180_000) fireTimeout = () => handler(...args);
    return originalTimer(handler, delay, ...args);
  }) as typeof setTimeout;
  duringProviderAwait = async (signal) => {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("Runtime turn was cancelled."), { name: "AbortError" })), { once: true });
      external.abort();
      fireTimeout!();
    });
  };
  try {
    await memory.advanceNextMemoryProjection({ context });
    const db = new Database(join(butlerData, "cognition/memory/generations", descriptor.generation_id, "graph.sqlite"), { readonly: true });
    try {
      const row = db.query<any, []>("SELECT * FROM memory_projection_windows").get();
      expect(row).toMatchObject({ state: "failed", error_code: "memory_extract_cancelled", attempt_count: 1, next_attempt_at: null });
      expect(JSON.parse(row.provider_evidence_json)).toMatchObject({ timeout_origin: "external", usage: null, remote_outcome: null });
    } finally { db.close(); }
  } finally {
    duringProviderAwait = null;
    globalThis.setTimeout = originalTimer;
  }
});

test("typed provider auth and configuration failures remain terminal with bounded diagnostics", async () => {
  const { ModelProviderRequestError } = await import("../../packages/butler-agent/src/integrations/providers/provider-request-errors.ts");
  const memory = await import("../../packages/butler-agent/src/agent/cognition/memory/projection/ingestion.ts");
  for (const [code, statusCode] of [["provider_auth_failed", 401], ["provider_model_not_found", 404]] as const) {
    const butlerData = mkdtempSync(join(tmpdir(), "memory-c08-auth-"));
    roots.push(butlerData);
    const descriptor = initializeEmptyMemoryGeneration(butlerData);
    const context = { butlerData, target: { kind: "active" as const, expected_generation: descriptor.generation_id }, signal: new AbortController().signal };
    await memory.ingestConversationMemory({ context,
      source: seedTurn(butlerData, "auth-session", "auth-turn", "내 고양이 루나의 영어 이름은 Luna야.", "Noted.", 1) });
    extractionFailure = () => new ModelProviderRequestError({ code, statusCode, retryable: false, message: "private provider body" });
    await memory.advanceNextMemoryProjection({ context });
    const db = new Database(join(butlerData, "cognition/memory/generations", descriptor.generation_id, "graph.sqlite"), { readonly: true });
    try {
      const row = db.query<any, []>("SELECT * FROM memory_projection_windows").get();
      expect(row).toMatchObject({ state: "failed", attempt_count: 1, next_attempt_at: null });
      expect(JSON.parse(row.provider_evidence_json)).toMatchObject({ provider_code: code, upstream_status: statusCode,
        timeout_origin: "unknown", usage: null, reported_model: null, remote_outcome: null });
      expect(row.provider_evidence_json).not.toContain("private provider body");
    } finally { db.close(); }
  }
});

test("saved plan apply failures retry through the normal advance owner without extractor replay", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-memory-plan-apply-"));
  roots.push(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const memory =
    await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  const context = {
    butlerData,
    target: {
      kind: "active" as const,
      expected_generation: descriptor.generation_id,
    },
    signal: new AbortController().signal,
  };
  const graphPath = join(
    butlerData,
    "cognition",
    "memory",
    "generations",
    descriptor.generation_id,
    "graph.sqlite",
  );
  const installApplyAbort = () => {
    const db = new Database(graphPath);
    db.exec(
      "CREATE TRIGGER fail_memory_plan_apply BEFORE INSERT ON entities BEGIN SELECT RAISE(ABORT, 'memory_write_busy'); END",
    );
    db.close();
  };
  const removeApplyAbort = () => {
    const db = new Database(graphPath);
    db.exec("DROP TRIGGER IF EXISTS fail_memory_plan_apply");
    db.close();
  };

  await memory.ingestConversationMemory({
    context,
    source: seedTurn(
      butlerData,
      "apply-session",
      "apply-turn",
      "내 고양이 루나의 영어 이름은 Luna야.",
      "알겠습니다.",
      1,
    ),
  });
  duringExtraction = () => {
    duringExtraction = null;
    installApplyAbort();
  };
  expect(
    (await memory.advanceNextMemoryProjection({ context }))?.semantic_graph
      .state,
  ).toBe("running");
  expect(extractionInputs).toHaveLength(1);
  let db = new Database(graphPath, { readonly: true });
  expect(
    db
      .query<
        { state: string; output_json: string | null; normalized_plan_json: string | null; owner_nonce: string | null },
        []
      >("SELECT state,output_json,normalized_plan_json,owner_nonce FROM memory_projection_windows")
      .get(),
  ).toMatchObject({ state: "planned" });
  const preservedPlan = db.query<{ output_json: string; normalized_plan_json: string; owner_nonce: string }, []>(
    "SELECT output_json,normalized_plan_json,owner_nonce FROM memory_projection_windows",
  ).get();
  expect(preservedPlan?.output_json).toBeString();
  expect(preservedPlan?.normalized_plan_json).toBeString();
  expect(preservedPlan?.owner_nonce).toBeString();
  expect(db.query<{ n: number }, []>(
    "SELECT COUNT(*) n FROM memory_projection_attempts WHERE attempt_kind='apply' OR state='failed'",
  ).get()!.n).toBe(0);
  db.close();

  removeApplyAbort();
  let recovered = await memory.advanceNextMemoryProjection({ context });
  for (let quantum = 1; quantum < 4 && recovered?.semantic_graph.state !== "complete"; quantum += 1) {
    recovered = await memory.advanceNextMemoryProjection({ context });
  }
  expect(recovered?.semantic_graph.state).toBe("complete");
  expect(extractionInputs).toHaveLength(1);
  db = new Database(graphPath, { readonly: true });
  expect(
    db.query<{ n: number }, []>("SELECT COUNT(*) n FROM entities").get()!.n,
  ).toBeGreaterThan(0);
  db.close();

  db = new Database(graphPath, { readonly: true });
  expect(db.query<{ n: number }, []>(
    "SELECT COUNT(*) n FROM memory_projection_attempts WHERE provider_invoked=1 AND outcome_known=1",
  ).get()!.n).toBe(1);
  expect(db.query<{ n: number }, []>(
    "SELECT COUNT(*) n FROM memory_projection_attempts WHERE state='interrupted' AND attempt_kind='apply' AND provider_invoked=0",
  ).get()!.n).toBe(1);
  db.close();

  const interruptedData = mkdtempSync(join(tmpdir(), "butler-memory-provider-gap-"));
  roots.push(interruptedData);
  const interruptedDescriptor = initializeEmptyMemoryGeneration(interruptedData);
  const normalInterruptedContext = {
    butlerData: interruptedData,
    target: { kind: "active" as const, expected_generation: interruptedDescriptor.generation_id },
    signal: new AbortController().signal,
  };
  await memory.ingestConversationMemory({
    context: normalInterruptedContext,
    source: seedTurn(interruptedData, "gap-session", "gap-turn", "내 고양이 루나의 영어 이름은 Luna야.", "알겠습니다.", 1),
  });
  let providerGapLease: ReturnType<typeof acquireConsolidationLock> = null;
  let interruptedDeadline = 0;
  duringExtraction = () => {
    providerGapLease = acquireConsolidationLock(consolidationLockPath(interruptedData), { purpose: "provider_gap_holder" });
    expect(providerGapLease).not.toBeNull();
  };
  duringProviderAwait = async () => {
    await Bun.sleep(Math.max(0, interruptedDeadline - Date.now() + 1));
    releaseConsolidationLock(consolidationLockPath(interruptedData), providerGapLease!);
    providerGapLease = null;
  };
  interruptedDeadline = Date.now() + 1_000;
  const interruptedContext = { ...normalInterruptedContext, deadlineAt: interruptedDeadline };
  try {
    const incomplete = await memory.advanceNextMemoryProjection({ context: interruptedContext });
    expect(incomplete?.semantic_graph.state).not.toBe("complete");
  } finally {
    if (providerGapLease) releaseConsolidationLock(consolidationLockPath(interruptedData), providerGapLease);
    duringExtraction = null;
    duringProviderAwait = null;
  }
  expect(extractionInputs).toHaveLength(2);
  db = new Database(join(interruptedData, "cognition", "memory", "generations", interruptedDescriptor.generation_id, "graph.sqlite"), { readonly: true });
  expect(db.query<{ state: string; output_json: string | null; normalized_plan_json: string | null }, []>(
    "SELECT state,output_json,normalized_plan_json FROM memory_projection_windows",
  ).get()).toEqual({ state: "running", output_json: null, normalized_plan_json: null });
  db.close();
  await memory.advanceNextMemoryProjection({ context: normalInterruptedContext });
  expect(extractionInputs).toHaveLength(2);
  db = new Database(join(interruptedData, "cognition", "memory", "generations", interruptedDescriptor.generation_id, "graph.sqlite"), { readonly: true });
  expect(db.query<{ state: string; error_code: string }, []>(
    "SELECT state,error_code FROM memory_projection_windows",
  ).get()).toEqual({ state: "failed", error_code: "memory_projection_outcome_unknown" });
  expect(db.query<{ provider_invoked: number; outcome_known: number }, []>(
    "SELECT provider_invoked,outcome_known FROM memory_projection_attempts WHERE invocation_ref IS NOT NULL ORDER BY recorded_at DESC LIMIT 1",
  ).get()).toEqual({ provider_invoked: 0, outcome_known: 0 });
  db.close();
});

test("split successor receives bounded canonical context while its predecessor is failed", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-memory-boundary-"));
  roots.push(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const memory = await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  const context = {
    butlerData,
    target: { kind: "active" as const, expected_generation: descriptor.generation_id },
    signal: new AbortController().signal,
  };
  const text = `${"👩‍👩‍👧‍👦\n".repeat(310)}العربية日本語연결`;
  const source = seedTurn(butlerData, "boundary-session", "boundary-turn", text, "Noted.", 1);
  const job = await memory.ingestConversationMemory({ context, source });
  const { ModelProviderRequestError } = await import("../../packages/butler-agent/src/integrations/providers/provider-request-errors.ts");
  let calls = 0;
  extractionFailure = () => {
    calls += 1;
    if (calls === 1) return new ModelProviderRequestError({ code: "context_length_exceeded", statusCode: 400, message: "split fixture", retryable: false });
    if (calls === 2) return new ModelProviderRequestError({ code: "invalid_request", statusCode: 400, message: "predecessor failed", retryable: false });
    return null;
  };
  transformExtractionOutput = (output) => Object.assign(output, { nodes: [], claims: [], relations: [], corrections: [], summary: null });
  const server = createServer((socket) => {
    let payload = "";
    socket.on("data", (chunk) => {
      payload += chunk.toString();
      if (!payload.includes("\n")) return;
      const request = JSON.parse(payload.trim()) as { texts: string[] };
      socket.end(`${JSON.stringify({
        embeddings: request.texts.map(() => [1, 0]), token_counts: request.texts.map(() => 2),
        embedded_texts: request.texts, omitted_count: 0,
        metadata: {
          model: "test/bge-m3", dimension: 2, pooling: "cls", normalize: true,
          version: "a".repeat(64), max_tokens: 8192, transformers_version: "test",
          node_runtime_version: process.version, bun_runtime_version: Bun.version,
          tokenizer_asset_sha256: "b".repeat(64), model_asset_sha256: "c".repeat(64),
        },
      })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(process.env.EMBED_SOCKET!, resolve); });
  try {
    for (let quantum = 0; quantum < 16 && calls < 3; quantum += 1) await memory.advanceNextMemoryProjection({ context });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  expect(calls).toBe(3);
  const predecessor = extractionInputs[1]!;
  const successor = extractionInputs[2]!;
  const precedingText = predecessor.source_units.at(-1).text as string;
  const boundaryContext = successor.context_units.at(-1);
  expect(boundaryContext).toBeDefined();
  expect(precedingText.endsWith(boundaryContext.text)).toBe(true);
  expect(boundaryContext.text.length).toBeGreaterThan(0);
  expect(boundaryContext.text.length).toBeLessThan(precedingText.length);
  expect(Buffer.byteLength(JSON.stringify(successor.context_units))).toBeLessThanOrEqual(4096);
  expect(Buffer.byteLength(JSON.stringify(successor))).toBeLessThanOrEqual(24576);
  const clusters = [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(precedingText)];
  expect(clusters.some((part) => part.index === precedingText.length - boundaryContext.text.length)).toBe(true);
  const db = new Database(join(butlerData, "cognition", "memory", "generations", descriptor.generation_id, "graph.sqlite"), { readonly: true });
  try {
    const previous = db.query<{ state: string; input_json: string; normalized_plan_json: string | null }, [string]>("SELECT state,input_json,normalized_plan_json FROM memory_projection_windows WHERE window_ref=?").get(predecessor.window_ref)!;
    expect(previous.state).toBe("failed");
    expect(previous.normalized_plan_json).toBeNull();
    expect(JSON.parse(previous.input_json).context_units).toEqual([]);
    const current = db.query<{ state: string; input_json: string }, [string]>("SELECT state,input_json FROM memory_projection_windows WHERE window_ref=?").get(successor.window_ref)!;
    expect(current.state).toBe("complete");
    const pinned = JSON.parse(current.input_json);
    expect(pinned.context_units.at(-1).ref).toBe(JSON.parse(previous.input_json).source_units.at(-1).ref);
    expect(pinned.source_units.map((unit: any) => unit.ref)).not.toContain(pinned.context_units.at(-1).ref);
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM memory_projection_windows WHERE job_id=? AND state='replaced'").get(job.job_id)!.n).toBe(1);
  } finally { db.close(); }
});

test("provider size failure splits a real multi-window source through the advance owner", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-memory-owner-split-"));
  roots.push(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const memory =
    await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  const context = {
    butlerData,
    target: {
      kind: "active" as const,
      expected_generation: descriptor.generation_id,
    },
    signal: new AbortController().signal,
  };
  const userParts = Array.from({ length: 159 }, (_, index) =>
    index === 0
      ? `루나 Luna ${"가".repeat(3_000)}`
      : `루나 Luna source-${String(index).padStart(3, "0")}`,
  );
  const assistantText = "루나 Luna assistant";
  const canonical = new AgentConversationStore({ butlerData });
  const turn = canonical.beginTurn({
    gateway: "app",
    externalSessionId: "split-owner-session",
    sessionId: "split-owner-session",
    projectId: "project-a",
    actor: "user",
    turnId: "split-owner-turn",
  });
  const user = canonical.appendUserMessage({
    sessionId: turn.session_id,
    turnId: turn.id,
    text: "",
    originKind: "user_input",
    originRef: "test:split:user",
    parts: userParts.map((text) => ({
      kind: "text" as const,
      contentJson: { text },
    })),
  });
  const assistant = canonical.appendAssistantMessage({
    sessionId: turn.session_id,
    turnId: turn.id,
    text: assistantText,
    originKind: "assistant_public",
    originRef: "test:split:assistant",
  });
  canonical.finalizeTurn({
    turnId: turn.id,
    status: "complete",
    outcomeCapsule: {
      sessionId: turn.session_id,
      turnId: turn.id,
      generation: 1,
      outcome: "delivered",
      requestMessageId: user.id,
      publicAssistantMessageId: assistant.id,
      providerId: "test",
      modelRef: "test/model",
    },
  });
  canonical.close();
  const progress = await memory.ingestConversationMemory({
    context,
    source: {
      kind: "conversation_turn",
      session_id: turn.session_id,
      turn_id: turn.id,
      outcome_generation: 1,
    },
  });
  const graphPath = join(
    butlerData,
    "cognition",
    "memory",
    "generations",
    descriptor.generation_id,
    "graph.sqlite",
  );
  let db = new Database(graphPath, { readonly: true });
  const originalWindows = Number(
    db
      .query<
        { n: number },
        []
      >("SELECT COUNT(*) n FROM memory_projection_windows WHERE state!='replaced'")
      .get()!.n,
  );
  db.close();
  expect(originalWindows).toBeGreaterThan(1);
  const { ModelProviderRequestError } = await import("../../packages/butler-agent/src/integrations/providers/provider-request-errors.ts");
  let extractionCall = 0;
  extractionFailure = () => {
    extractionCall += 1;
    return extractionCall === 1 || extractionCall === 3
      ? new ModelProviderRequestError({ code: "context_length_exceeded", statusCode: 400, message: "memory_extract_output_exceeds_budget", retryable: false })
      : null;
  };
  const first = await memory.advanceNextMemoryProjection({ context });
  expect(first?.job_id).toBe(progress.job_id);
  db = new Database(graphPath, { readonly: true });
  const splitAttempt = db
    .query<
      {
        attempt_kind: string;
        provider_invoked: number;
        output_json: string | null;
        provider_evidence_json: string;
      },
      []
    >(
      "SELECT attempt_kind,provider_invoked,output_json,provider_evidence_json FROM memory_projection_attempts WHERE error_code='memory_extract_output_exceeds_budget'",
    )
    .get();
  expect(splitAttempt).toMatchObject({
    attempt_kind: "provider",
    provider_invoked: 1,
    output_json: null,
  });
  const splitEvidence = JSON.parse(splitAttempt!.provider_evidence_json);
  expect(splitEvidence).toMatchObject({ failure_kind: "before_result", provider_code: "context_length_exceeded", upstream_status: 400, usage: null, reported_model: null, remote_outcome: null });
  expect(splitEvidence.local_elapsed_ms).toBeGreaterThanOrEqual(0);
  expect(
    Number(
      db
        .query<
          { n: number },
          []
        >("SELECT COUNT(*) n FROM memory_projection_windows WHERE state='replaced'")
        .get()!.n,
    ),
  ).toBe(1);
  expect(
    Number(
      db
        .query<
          { n: number },
          []
        >("SELECT COUNT(*) n FROM memory_projection_windows WHERE state!='replaced'")
        .get()!.n,
    ),
  ).toBe(originalWindows + 1);
  const archivedParent = db
    .query<
      { source_id: string; child_source_ids_json: string },
      []
    >("SELECT source_id,child_source_ids_json FROM memory_source_split_parents")
    .get();
  db.close();
  expect(archivedParent).not.toBeNull();
  expect(
    memory.resolveMemorySource({
      context,
      sourceRef: archivedParent!.source_id,
    }).text.length,
  ).toBeGreaterThan(0);
  transformExtractionOutput = (output, input) => {
    output.summary = null;
    const unit = input.source_units.find((item: any) =>
      item.text.includes("Luna"),
    );
    if (!unit || !output.nodes[0]) return;
    output.nodes[0].evidence = [
      { unit_ref: unit.ref, quote: "Luna", occurrence: 0 },
    ];
  };
  let completedLeaf: {
    window_ref: string;
    output_json: string;
    normalized_plan_json: string;
    provider_evidence_json: string;
  } | null = null;
  for (let step = 0; step < 8 && extractionCall < 3; step += 1) {
    const writable = new Database(graphPath);
    writable
      .query(
        "UPDATE memory_projection_jobs SET next_stage='semantic_graph' WHERE job_id=?",
      )
      .run(progress.job_id);
    writable.close();
    await memory.advanceNextMemoryProjection({ context });
    const check = new Database(graphPath, { readonly: true });
    const complete = Number(
      check
        .query<
          { n: number },
          [string]
        >("SELECT COUNT(*) n FROM memory_projection_windows WHERE job_id=? AND state='complete'")
        .get(progress.job_id)!.n,
    );
    if (complete > 0 && !completedLeaf) {
      completedLeaf =
        check
          .query<
            {
              window_ref: string;
              output_json: string;
              normalized_plan_json: string;
              provider_evidence_json: string;
            },
            [string]
          >(
            `
        SELECT window_ref,output_json,normalized_plan_json,provider_evidence_json FROM memory_projection_windows
        WHERE job_id=? AND state='complete' ORDER BY ordinal LIMIT 1
      `,
          )
          .get(progress.job_id) ?? null;
    }
    check.close();
  }
  db = new Database(graphPath, { readonly: true });
  expect(extractionCall).toBe(3);
  const replaced = db
    .query<{ window_ref: string; parent_window_ref: string | null }, [string]>(
      `
    SELECT window_ref,parent_window_ref FROM memory_projection_windows WHERE job_id=? AND state='replaced' ORDER BY rowid
  `,
    )
    .all(progress.job_id);
  expect(replaced).toHaveLength(2);
  expect(replaced[1]!.parent_window_ref).toBe(replaced[0]!.window_ref);
  expect(completedLeaf).not.toBeNull();
  expect(
    db
      .query<
        { parent_window_ref: string | null },
        [string]
      >("SELECT parent_window_ref FROM memory_projection_windows WHERE window_ref=?")
      .get(completedLeaf!.window_ref)?.parent_window_ref,
  ).toBe(replaced[0]!.window_ref);
  const completedAfterSecondSplit = db
    .query<
      {
        window_ref: string;
        output_json: string;
        normalized_plan_json: string;
        provider_evidence_json: string;
      },
      [string]
    >(
      `
    SELECT window_ref,output_json,normalized_plan_json,provider_evidence_json FROM memory_projection_windows WHERE window_ref=?
  `,
    )
    .get(completedLeaf!.window_ref);
  expect(completedAfterSecondSplit).toEqual(completedLeaf);
  const orderedRefs = db
    .query<{ source_refs_json: string }, [string]>(
      "SELECT source_refs_json FROM memory_projection_windows WHERE job_id=? AND state!='replaced' ORDER BY ordinal",
    )
    .all(progress.job_id)
    .flatMap((row) => JSON.parse(row.source_refs_json) as string[]);
  const activeBeforeReplay = db
    .query<
      { window_ref: string; source_refs_json: string; state: string },
      []
    >("SELECT window_ref,source_refs_json,state FROM memory_projection_windows WHERE state!='replaced' ORDER BY ordinal")
    .all();
  db.close();
  expect(new Set(orderedRefs).size).toBe(orderedRefs.length);
  expect(
    [...new Set(orderedRefs)]
      .map(
        (ref) => memory.resolveMemorySource({ context, sourceRef: ref }).text,
      )
      .join(""),
  ).toBe(`${userParts.join("")}${assistantText}`);
  await memory.ingestConversationMemory({
    context,
    source: {
      kind: "conversation_turn",
      session_id: "split-owner-session",
      turn_id: "split-owner-turn",
      outcome_generation: 1,
    },
    completionJobId: "same-owner-notice",
  });
  db = new Database(graphPath, { readonly: true });
  expect(
    db
      .query<
        {
          window_ref: string;
          output_json: string;
          normalized_plan_json: string;
          provider_evidence_json: string;
        },
        [string]
      >(
        `
    SELECT window_ref,output_json,normalized_plan_json,provider_evidence_json FROM memory_projection_windows WHERE window_ref=?
  `,
      )
      .get(completedLeaf!.window_ref),
  ).toEqual(completedLeaf);
  expect(
    db
      .query<
        { window_ref: string; source_refs_json: string },
        []
      >("SELECT window_ref,source_refs_json FROM memory_projection_windows WHERE state!='replaced' ORDER BY ordinal")
      .all(),
  ).toEqual(
    activeBeforeReplay.map(({ window_ref, source_refs_json }) => ({
      window_ref,
      source_refs_json,
    })),
  );
  db.close();
});

test("tool bridge preserves selected native v2 and omits absent historical metadata", async () => {
  const resolve = async (
    definition:
      | typeof recallMemoryToolDefinition
      | Omit<typeof recallMemoryToolDefinition, "toolContractVersion">,
  ) => {
    const handler = createToolCallToolHandler({
      butlerData: "/tmp/unused-memory-bridge",
      dispatchTool: async () => ({ ok: true }),
      currentToolNames: ["tool_call", "recall_memory"],
      describedToolIds: ["native:recall_memory"],
      nativeToolDefinitions: [definition],
    });
    return (await handler({
      args: {
        id: "native:recall_memory",
        arguments: { cue: "Luna", include_vector: false },
        __bridge_resolve_only: true,
      },
    })) as any;
  };
  const fresh = await resolve(recallMemoryToolDefinition);
  expect(fresh.targetCall.toolContractVersion).toBe(2);
  const { toolContractVersion: _omitted, ...historical } =
    recallMemoryToolDefinition;
  const old = await resolve(historical);
  expect(Object.hasOwn(old.targetCall, "toolContractVersion")).toBe(false);
});

test("empty initialization rejects orphan canonical and derived source content", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-memory-empty-"));
  roots.push(butlerData);
  const taskDir = join(butlerData, "tasks", "orphan");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "request.md"), "source-bearing request");
  expect(() => initializeEmptyMemoryGeneration(butlerData)).toThrow(
    "memory_initialization_requires_rebuild",
  );
  rmSync(join(butlerData, "tasks"), { recursive: true, force: true });

  const boxDir = join(butlerData, "cognition", "box", "orphan");
  mkdirSync(boxDir, { recursive: true });
  writeFileSync(join(boxDir, "payload.txt"), "source-bearing box payload");
  expect(() => initializeEmptyMemoryGeneration(butlerData)).toThrow(
    "memory_initialization_requires_rebuild",
  );
  rmSync(join(butlerData, "cognition", "box"), {
    recursive: true,
    force: true,
  });

  const legacyDir = join(butlerData, "cognition", "memory");
  mkdirSync(legacyDir, { recursive: true });
  const legacy = new Database(join(legacyDir, "metadata.sqlite"), {
    create: true,
  });
  legacy.exec(
    "CREATE TABLE unknown_payload(value TEXT); INSERT INTO unknown_payload VALUES('source')",
  );
  legacy.close();
  expect(() => initializeEmptyMemoryGeneration(butlerData)).toThrow(
    "memory_initialization_requires_rebuild",
  );
});

test("ordinary projection open does not create or repair a generation", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-memory-no-repair-"));
  roots.push(root);
  const missing = join(root, "missing", "graph.sqlite");
  expect(() => openProjectionDb(missing)).toThrow();
  expect(existsSync(missing)).toBe(false);
});

test("claim reuse rejects global-project scope crossing in both directions", () => {
  for (const item of [
    { boundProjectId: "project-a", scope: "user", projectId: null },
    {
      boundProjectId: null,
      scope: "project",
      projectId: "project-a",
    },
  ] as const) {
    const input = {
      schema: "butler.memory-extract-input.v2" as const,
      episode_ref: "episode",
      revision: "revision",
      window_ref: "window",
      bound_project_id: item.boundProjectId,
      source_units: [
        {
          ref: "current",
          text: "Luna likes",
          role: "user" as const,
          observed_at: "2026-09-08T00:00:00.000Z",
          origin_kind: "user_input" as const,
        },
      ],
      context_units: [],
      candidates: [
        {
          ref: "candidate",
          type: "preference" as const,
          label: "Luna likes",
          aliases: ["Luna likes"],
          scope: item.scope,
          project_id: item.projectId,
          evidence: [
            {
              ref: "prior",
              text: "Luna likes",
              observed_at: "2026-09-07T00:00:00.000Z",
              basis: "user_statement" as const,
            },
          ],
        },
      ],
    };
    const output = {
      schema: "butler.memory-extract-output.v2" as const,
      window_ref: "window",
      disposition: "processed" as const,
      covered_unit_refs: ["current"],
      nodes: [],
      claims: [
        {
          local_ref: "claim",
          type: "preference" as const,
          resolution: {
            kind: "reuse" as const,
            node_ref: "candidate",
            reason: "explicit_alias" as const,
            evidence: [
              { unit_ref: "current", quote: "Luna", occurrence: 0 },
              { unit_ref: "prior", quote: "Luna", occurrence: 0 },
            ],
          },
          statement: "Luna likes",
          subject_ref: null,
          object_ref: null,
          speech_act: "assertion" as const,
          basis: "user_statement" as const,
          polarity: "positive" as const,
          condition: null,
          valid_from: null,
          valid_to: null,
          salience: "normal" as const,
          evidence: [
            { unit_ref: "current", quote: "Luna likes", occurrence: 0 },
          ],
        },
      ],
      relations: [],
      corrections: [],
      summary: null,
    };
    expect(() =>
      normalizeAndValidatePlan(null as never, input, output),
    ).toThrow("memory_extract_invalid_identity_reuse");
  }
});

test("memory writer lease is not age-stolen and only its owner can release it", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-memory-lease-"));
  roots.push(root);
  const path = consolidationLockPath(root);
  const lockModule = pathToFileURL(join(process.cwd(), "packages/butler-agent/src/agent/cognition/memory/scripts/lib/lock.ts")).href;
  const holder = Bun.spawn({
    cmd: [process.execPath, "-e", `
      import { acquireConsolidationLock } from ${JSON.stringify(lockModule)};
      const lease = acquireConsolidationLock(${JSON.stringify(path)}, { purpose: "child_holder" });
      if (!lease) process.exit(2);
      console.log("held");
      setInterval(() => {}, 1_000);
    `],
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const held = await holder.stdout.getReader().read();
    expect(new TextDecoder().decode(held.value)).toContain("held");
    expect(
      acquireConsolidationLock(path, { staleAgeMs: 0, purpose: "other" }),
    ).toBeNull();
    const source = seedTurn(root, "lease-session", "lease-turn", "canonical publication remains independent", "acknowledged", 1);
    publishConversationCompletionObservation({
      butlerData: root,
      runtimeSessionId: "butler/lease-session",
      conversationSessionId: source.session_id,
      conversationTurnId: source.turn_id,
      inboundMessageId: source.request_message_id,
      outboundMessageId: source.assistant_message_id,
      outcomeGeneration: source.outcome_generation,
      completedAt: new Date().toISOString(),
    });
    expect(peek(root)).toMatchObject({ source: { kind: "conversation_turn", turn_id: source.turn_id } });
  } finally {
    holder.kill();
    await holder.exited;
  }

  const lease = acquireConsolidationLock(path, { purpose: "test_owner" });
  expect(lease).not.toBeNull();
  releaseConsolidationLock(path, {
    owner_nonce: "wrong",
    purpose: "test_owner",
  });
  expect(inspectConsolidationLock(path).state).toBe("held");
  const waiter = acquireConsolidationLockAsync(path, {
    purpose: "waiting_owner",
    waitClass: "interactive",
    deadlineAt: Date.now() + 1_000,
  });
  releaseConsolidationLock(path, lease!);
  const waitedLease = await waiter;
  expect(waitedLease).not.toBeNull();
  releaseConsolidationLock(path, waitedLease!);
  expect(existsSync(path)).toBe(true);
  expect(inspectConsolidationLock(path).state).toBe("free");
  expect(sweepStaleLocks(root)).toEqual([]);

  const legacyPath = join(root, "legacy.lock");
  const stale = JSON.stringify({
    pid: process.pid,
    startedAt: "2000-01-01T00:00:00.000Z",
    host: hostname(),
    owner_nonce: "live-legacy-owner",
    purpose: "legacy-owner",
  });
  const legacyHolder = Bun.spawn({
    cmd: [process.execPath, "-e", `
      const fs = await import("node:fs");
      const os = await import("node:os");
      fs.writeFileSync(${JSON.stringify(legacyPath)}, JSON.stringify({
        pid: process.pid, startedAt: "2000-01-01T00:00:00.000Z", host: os.hostname(),
        owner_nonce: "live-legacy-owner", purpose: "legacy-owner",
      }), { flag: "wx" });
      console.log("held");
      setInterval(() => {}, 1_000);
    `],
    stdout: "pipe",
    stderr: "pipe",
  });
  let exactLegacyBytes = "";
  try {
    const legacyHeld = await legacyHolder.stdout.getReader().read();
    expect(new TextDecoder().decode(legacyHeld.value)).toContain("held");
    exactLegacyBytes = await Bun.file(legacyPath).text();
    expect(inspectConsolidationLock(legacyPath).state).toBe("legacy_blocked");
    expect(() => acquireConsolidationLock(legacyPath, { purpose: "replacement" })).toThrow("memory_write_legacy_blocked");
  } finally {
    legacyHolder.kill();
    await legacyHolder.exited;
  }
  const replacement = acquireConsolidationLock(legacyPath, { purpose: "replacement" });
  expect(replacement).not.toBeNull();
  expect(await Bun.file(legacyPath).text()).toBe(exactLegacyBytes);
  expect(() => writeFileSync(legacyPath, stale, { flag: "wx" })).toThrow();
  releaseConsolidationLock(legacyPath, replacement!);
});

test("memory writer lease excludes SQLite readers before ownership is granted", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-memory-reader-gate-"));
  roots.push(root);
  const path = consolidationLockPath(root);
  const initial = acquireConsolidationLock(path, { purpose: "initialize_reader_gate" });
  expect(initial).not.toBeNull();
  releaseConsolidationLock(path, initial!);

  const coordinatorPath = `${path}.coord.sqlite`;
  const reader = Bun.spawn({
    cmd: [process.execPath, "-e", `
      import { Database } from "bun:sqlite";
      const db = new Database(${JSON.stringify(`${path}.coord.sqlite`)}, { readonly: true });
      db.exec("BEGIN");
      db.query("SELECT format_version FROM memory_write_gate WHERE singleton=1").get();
      console.log("held");
      await Bun.stdin.text();
      db.exec("ROLLBACK");
      db.close();
    `],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let waiterLease: Awaited<ReturnType<typeof acquireConsolidationLockAsync>> = null;
  let readerReleased = false;
  try {
    const held = await reader.stdout.getReader().read();
    expect(new TextDecoder().decode(held.value)).toContain("held");
    expect(acquireConsolidationLock(path, { purpose: "reader_blocked_owner" })).toBeNull();
    const waiter = acquireConsolidationLockAsync(path, {
      purpose: "yielding_reader_owner", waitClass: "background", deadlineAt: Date.now() + 1_000,
    });
    reader.stdin.write("release\n");
    reader.stdin.end();
    readerReleased = true;
    expect(await reader.exited).toBe(0);
    waiterLease = await waiter;
    expect(waiterLease).not.toBeNull();

    const blockedReader = Bun.spawnSync([process.execPath, "-e", `
      import { Database } from "bun:sqlite";
      let db;
      try {
        db = new Database(${JSON.stringify(`${path}.coord.sqlite`)}, { readonly: true });
        db.query("SELECT format_version FROM memory_write_gate WHERE singleton=1").get();
        process.exitCode = 2;
      } catch (error) {
        if (error?.code !== "SQLITE_BUSY") throw error;
        console.log(error.code);
      } finally { db?.close(); }
    `]);
    expect(blockedReader.exitCode).toBe(0);
    expect(blockedReader.stdout.toString()).toContain("SQLITE_BUSY");
    releaseConsolidationLock(path, waiterLease!);
    waiterLease = null;

    const releasedReader = new Database(coordinatorPath, { readonly: true });
    try {
      expect(releasedReader.query("SELECT format_version FROM memory_write_gate WHERE singleton=1").get()).toBeTruthy();
    } finally {
      releasedReader.close();
    }
    const next = acquireConsolidationLock(path, { purpose: "post_reader_owner" });
    expect(next).not.toBeNull();
    releaseConsolidationLock(path, next!);
  } finally {
    if (!readerReleased) {
      try { reader.stdin.write("release\n"); reader.stdin.end(); } catch {}
      await reader.exited;
    }
    if (waiterLease) releaseConsolidationLock(path, waiterLease, false);
  }
});

test("canonical mutation during extraction rejects the stale plan", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-memory-mutation-"));
  roots.push(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const source = seedTurn(
    butlerData,
    "session-mutation",
    "turn-mutation",
    "내 고양이 루나의 영어 이름은 Luna야.",
    "Noted.",
    1,
  );
  const memory =
    await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  const context = {
    butlerData,
    target: {
      kind: "active" as const,
      expected_generation: descriptor.generation_id,
    },
    signal: new AbortController().signal,
  };
  await memory.ingestConversationMemory({ context, source });
  duringExtraction = () => {
    const canonical = new Database(
      join(butlerData, "runtime", "conversation-store.sqlite"),
    );
    try {
      canonical
        .query(
          "UPDATE conversation_parts SET content_json=? WHERE message_id=?",
        )
        .run(
          JSON.stringify({ text: "내 고양이의 영어 이름은 Sol이야." }),
          source.request_message_id,
        );
    } finally {
      canonical.close();
    }
    duringExtraction = null;
  };
  const progress = await memory.advanceNextMemoryProjection({ context });
  expect(progress?.semantic_graph.state).toBe("partial");
  const graph = new Database(
    join(
      butlerData,
      "cognition",
      "memory",
      "generations",
      descriptor.generation_id,
      "graph.sqlite",
    ),
    { readonly: true },
  );
  try {
    expect(
      graph
        .query<{ count: number }, []>("SELECT COUNT(*) count FROM edges")
        .get()!.count,
    ).toBe(0);
    expect(
      graph
        .query<
          { error_code: string },
          []
        >("SELECT error_code FROM memory_projection_windows LIMIT 1")
        .get()!.error_code,
    ).toBe("memory_source_changed");
  } finally {
    graph.close();
  }
});

test("fresh candidate authority change invalidates only the affected normal-owner window", async () => {
  const butlerData = mkdtempSync(
    join(tmpdir(), "butler-memory-candidate-mutation-"),
  );
  roots.push(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const memory =
    await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  const context = {
    butlerData,
    target: {
      kind: "active" as const,
      expected_generation: descriptor.generation_id,
    },
    signal: new AbortController().signal,
  };
  const firstSource = seedTurn(
    butlerData,
    "candidate-session-a",
    "candidate-turn-a",
    "내 고양이 루나의 영어 이름은 Luna야.",
    "Luna 기록을 확인했습니다.",
    1,
  );
  const first = await memory.ingestConversationMemory({
    context,
    source: firstSource,
  });
  expect(
    (await memory.advanceNextMemoryProjection({ context }))?.semantic_graph
      .state,
  ).toBe("complete");
  const graphPath = join(
    butlerData,
    "cognition",
    "memory",
    "generations",
    descriptor.generation_id,
    "graph.sqlite",
  );
  let graph = new Database(graphPath);
  const firstPlan = graph
    .query<
      {
        output_json: string;
        normalized_plan_json: string;
        provider_evidence_json: string;
      },
      [string]
    >(
      "SELECT output_json,normalized_plan_json,provider_evidence_json FROM memory_projection_windows WHERE job_id=?",
    )
    .get(first.job_id)!;
  graph
    .query(
      "UPDATE memory_projection_jobs SET node_vectors_state=?,episode_vectors_state=?,hot_cache_state=? WHERE job_id=?",
    )
    .run(
      JSON.stringify({
        state: "failed",
        code: "fixture_closed",
        retryable: false,
        next_attempt_at: null,
      }),
      JSON.stringify({
        state: "failed",
        code: "fixture_closed",
        retryable: false,
        next_attempt_at: null,
      }),
      JSON.stringify({ state: "complete", completed_units: 1, total_units: 1 }),
      first.job_id,
    );
  graph
    .query(
      "UPDATE memory_vector_units SET state='failed',error_code='fixture_closed' WHERE job_id=?",
    )
    .run(first.job_id);
  graph.close();

  const secondSource = seedTurn(
    butlerData,
    "candidate-session-b",
    "candidate-turn-b",
    "Luna likes a blue ball.",
    "Recorded.",
    1,
  );
  const second = await memory.ingestConversationMemory({
    context,
    source: secondSource,
  });
  duringExtraction = () => {
    duringExtraction = null;
    const canonical = new Database(
      join(butlerData, "runtime", "conversation-store.sqlite"),
    );
    canonical
      .query("UPDATE conversation_parts SET content_json=? WHERE message_id=?")
      .run(
        JSON.stringify({ text: "Luna 기록은 현재 재검토 중입니다." }),
        firstSource.assistant_message_id,
      );
    canonical.close();
  };
  expect((await memory.advanceNextMemoryProjection({ context }))?.job_id).toBe(
    second.job_id,
  );
  graph = new Database(graphPath, { readonly: true });
  expect(
    graph
      .query<
        {
          state: string;
          input_json: string | null;
          output_json: string | null;
          normalized_plan_json: string | null;
          error_code: string;
        },
        [string]
      >(
        `
    SELECT state,input_json,output_json,normalized_plan_json,error_code FROM memory_projection_windows WHERE job_id=?
  `,
      )
      .get(second.job_id),
  ).toEqual({
    state: "pending",
    input_json: null,
    output_json: null,
    normalized_plan_json: null,
    error_code: "memory_extract_candidate_changed",
  });
  expect(
    graph
      .query<
        {
          output_json: string;
          normalized_plan_json: string;
          provider_evidence_json: string;
        },
        [string]
      >(
        "SELECT output_json,normalized_plan_json,provider_evidence_json FROM memory_projection_windows WHERE job_id=?",
      )
      .get(first.job_id),
  ).toEqual(firstPlan);
  graph.close();
});

test("third-attempt candidate invalidation is exhausted and never invokes extractor four", async () => {
  const butlerData = mkdtempSync(
    join(tmpdir(), "butler-memory-candidate-exhausted-"),
  );
  roots.push(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const memory =
    await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  const context = {
    butlerData,
    target: {
      kind: "active" as const,
      expected_generation: descriptor.generation_id,
    },
    signal: new AbortController().signal,
  };
  const firstSource = seedTurn(
    butlerData,
    "candidate-terminal-a",
    "candidate-terminal-turn-a",
    "내 고양이 루나의 영어 이름은 Luna야.",
    "Luna 기록을 확인했습니다.",
    1,
  );
  const first = await memory.ingestConversationMemory({
    context,
    source: firstSource,
  });
  await memory.advanceNextMemoryProjection({ context });
  const graphPath = join(
    butlerData,
    "cognition",
    "memory",
    "generations",
    descriptor.generation_id,
    "graph.sqlite",
  );
  let graph = new Database(graphPath);
  graph
    .query(
      "UPDATE memory_projection_jobs SET node_vectors_state=?,episode_vectors_state=?,hot_cache_state=? WHERE job_id=?",
    )
    .run(
      JSON.stringify({
        state: "failed",
        code: "fixture_closed",
        retryable: false,
        next_attempt_at: null,
      }),
      JSON.stringify({
        state: "failed",
        code: "fixture_closed",
        retryable: false,
        next_attempt_at: null,
      }),
      JSON.stringify({ state: "complete", completed_units: 1, total_units: 1 }),
      first.job_id,
    );
  graph
    .query(
      "UPDATE memory_vector_units SET state='failed',error_code='fixture_closed' WHERE job_id=?",
    )
    .run(first.job_id);
  graph.close();

  const secondSource = seedTurn(
    butlerData,
    "candidate-terminal-b",
    "candidate-terminal-turn-b",
    "Luna likes a blue ball.",
    "Recorded.",
    1,
  );
  const second = await memory.ingestConversationMemory({
    context,
    source: secondSource,
  });
  graph = new Database(graphPath);
  graph
    .query(
      "UPDATE memory_projection_windows SET attempt_count=2 WHERE job_id=?",
    )
    .run(second.job_id);
  graph.close();
  duringExtraction = () => {
    duringExtraction = null;
    const canonical = new Database(
      join(butlerData, "runtime", "conversation-store.sqlite"),
    );
    canonical
      .query("UPDATE conversation_parts SET content_json=? WHERE message_id=?")
      .run(
        JSON.stringify({ text: "Luna 기록은 현재 폐기되었습니다." }),
        firstSource.assistant_message_id,
      );
    canonical.close();
  };
  await memory.advanceNextMemoryProjection({ context });
  const callsAfterExhaustion = extractionInputs.length;
  graph = new Database(graphPath, { readonly: true });
  expect(
    graph
      .query<
        {
          state: string;
          attempt_count: number;
          error_code: string;
          normalized_plan_json: string | null;
        },
        [string]
      >(
        `
    SELECT state,attempt_count,error_code,normalized_plan_json FROM memory_projection_windows WHERE job_id=?
  `,
      )
      .get(second.job_id),
  ).toEqual({
    state: "failed",
    attempt_count: 3,
    error_code: "memory_projection_attempts_exhausted",
    normalized_plan_json: null,
  });
  expect(
    graph
      .query<
        { error_code: string; attempt_kind: string; provider_invoked: number },
        [string]
      >(
        `
    SELECT error_code,attempt_kind,provider_invoked FROM memory_projection_attempts WHERE job_id=? AND attempt_count=3 AND state='failed'
  `,
      )
      .get(second.job_id),
  ).toEqual({
    error_code: "memory_extract_candidate_changed",
    attempt_kind: "apply",
    provider_invoked: 0,
  });
  graph.close();
  await memory.advanceNextMemoryProjection({ context });
  expect(extractionInputs).toHaveLength(callsAfterExhaustion);
});

test("same projection reuses measured inference while rewriting current source provenance", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-memory-vector-reuse-"));
  roots.push(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const memory =
    await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  const vectors =
    await import("../../packages/butler-agent/src/agent/cognition/memory/recall/vector.ts");
  const generationOwner =
    await import("../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts");
  const context = {
    butlerData,
    target: {
      kind: "active" as const,
      expected_generation: descriptor.generation_id,
    },
    signal: new AbortController().signal,
  };
  const socketPath = process.env.EMBED_SOCKET!;
  let projectionInferences = 0;
  const server = createServer((socket) => {
    let payload = "";
    socket.on("data", (chunk) => {
      payload += chunk.toString();
      if (!payload.includes("\n")) return;
      const request = JSON.parse(payload.trim()) as { texts: string[] };
      projectionInferences += request.texts.filter((text) =>
        text.startsWith('type:"entity"'),
      ).length;
      socket.end(
        `${JSON.stringify({
          embeddings: request.texts.map(() => [1, 0]),
          token_counts: request.texts.map(() => 2),
          embedded_texts: request.texts,
          omitted_count: 0,
          metadata: {
            model: "test/bge-m3",
            dimension: 2,
            pooling: "cls",
            normalize: true,
            version: "a".repeat(64),
            max_tokens: 8192,
            transformers_version: "test",
            node_runtime_version: process.version,
            bun_runtime_version: Bun.version,
            tokenizer_asset_sha256: "b".repeat(64),
            model_asset_sha256: "c".repeat(64),
          },
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    const addEventClaim = (
      output: Record<string, any>,
      input: Record<string, any>,
      validFrom: string,
      validTo: string,
    ) => {
      const source =
        input.source_units.find((unit: any) => unit.role === "user") ??
        input.source_units[0];
      output.claims.push({
        local_ref: `event-${validFrom}`,
        type: "memory_atom",
        resolution: {
          kind: "create",
          provisional: false,
          identity_scope: "user",
        },
        statement: source.text,
        subject_ref: "luna",
        object_ref: null,
        speech_act: "assertion",
        basis: "user_statement",
        polarity: "positive",
        condition: null,
        valid_from: validFrom,
        valid_to: validTo,
        salience: "normal",
        evidence: [{ unit_ref: source.ref, quote: source.text, occurrence: 0 }],
      });
    };
    transformExtractionOutput = (output, input) =>
      addEventClaim(
        output,
        input,
        "2025-01-01T00:00:00.000Z",
        "2025-02-01T00:00:00.000Z",
      );
    const firstSource = seedTurn(
      butlerData,
      "vector-reuse-a",
      "vector-reuse-turn-a",
      "과거 일정: 내 고양이 루나의 영어 이름은 Luna야.",
      "Noted.",
      1,
      undefined,
      null,
    );
    const first = await memory.ingestConversationMemory({
      context,
      source: firstSource,
    });
    expect(
      (await memory.advanceNextMemoryProjection({ context }))?.semantic_graph
        .state,
    ).toBe("complete");
    const graphPath = join(
      butlerData,
      "cognition",
      "memory",
      "generations",
      descriptor.generation_id,
      "graph.sqlite",
    );
    let db = new Database(graphPath);
    db.query(
      `UPDATE memory_vector_units SET state='failed',error_code='fixture_nonshared_claim'
      WHERE job_id=? AND record_kind='node' AND owner_id IN (SELECT id FROM entities WHERE type='memory_atom')`,
    ).run(first.job_id);
    db.query(
      "UPDATE memory_projection_jobs SET next_stage='node_vectors' WHERE job_id=?",
    ).run(first.job_id);
    db.close();
    expect(
      (await memory.advanceNextMemoryProjection({ context }))?.node_vectors
        .state,
    ).toBe("partial");
    expect(projectionInferences).toBe(1);
    const generation = generationOwner.resolveMemoryGeneration(context);
    const lance = await import("@lancedb/lancedb");
    const legacyConnection = await lance.connect(
      join(generation.root, "butler.lance"),
    );
    const legacyTable = await legacyConnection.openTable("butler_memory");
    const [persistedNode] = await legacyTable.query().where(
      `generation = '${generation.generationId}' AND record_kind = 'node'`,
    ).select([
      "vector_key",
      "record_kind",
      "owner_id",
      "owner_revision",
      "source_revision",
      "embedding_version",
      "project_id",
      "origin_kind",
      "source_kind",
      "conversation_session_id",
      "source_observed_at",
      "source_refs_json",
    ]).limit(1).toArray() as Array<Record<string, any>>;
    expect(persistedNode).toBeDefined();
    await legacyTable.dropColumns(["source_kind"]);
    expect(await vectors.findPersistedVectorReceipt(
      generation,
      [{
        unit_id: "fixture-legacy-unit",
        job_id: first.job_id,
        record_kind: persistedNode!.record_kind,
        owner_id: persistedNode!.owner_id,
        owner_revision: persistedNode!.owner_revision,
        project_id: persistedNode!.project_id || null,
        origin_kind: persistedNode!.origin_kind,
        projection_text: "",
        source_revision: persistedNode!.source_revision,
        conversation_session_id: persistedNode!.conversation_session_id,
        source_kind: persistedNode!.source_kind,
        source_observed_at: persistedNode!.source_observed_at,
        source_ids_json: persistedNode!.source_refs_json,
        receipt_json: JSON.stringify({ vector_keys: [persistedNode!.vector_key] }),
        attempt_count: 1,
        owner_nonce: "fixture-legacy-owner",
      }],
      persistedNode!.embedding_version,
    )).toBeNull();
    db = new Database(graphPath);
    db.query(
      "UPDATE memory_vector_units SET state='failed',error_code='fixture_closed' WHERE job_id=? AND record_kind='episode'",
    ).run(first.job_id);
    db.query(
      "UPDATE memory_projection_jobs SET episode_vectors_state=?,hot_cache_state=? WHERE job_id=?",
    ).run(
      JSON.stringify({
        state: "failed",
        code: "fixture_closed",
        retryable: false,
        next_attempt_at: null,
      }),
      JSON.stringify({ state: "complete", completed_units: 1, total_units: 1 }),
      first.job_id,
    );
    db.close();

    await Bun.sleep(5);
    transformExtractionOutput = (output, input) => {
      const candidate = input.candidates.find(
        (item: any) => item.type === "entity" && item.aliases.includes("Luna"),
      );
      if (!candidate) return;
      output.nodes[0].resolution = {
        kind: "reuse",
        node_ref: candidate.ref,
        reason: "explicit_alias",
        evidence: [
          output.nodes[0].evidence[0],
          { unit_ref: candidate.evidence[0].ref, quote: "Luna", occurrence: 0 },
        ],
      };
      addEventClaim(
        output,
        input,
        "2026-01-01T00:00:00.000Z",
        "2026-02-01T00:00:00.000Z",
      );
    };
    const secondSource = seedTurn(
      butlerData,
      "vector-reuse-b",
      "vector-reuse-turn-b",
      "현재 일정: 내 고양이 루나의 영어 이름은 Luna야.",
      "Noted.",
      1,
      undefined,
      null,
    );
    const second = await memory.ingestConversationMemory({
      context,
      source: secondSource,
    });
    expect(
      (await memory.advanceNextMemoryProjection({ context }))?.semantic_graph
        .state,
    ).toBe("complete");
    db = new Database(graphPath);
    const pendingReuse = db
      .query<{ state: string; receipt_json: string | null }, [string]>(
        `SELECT u.state,u.receipt_json FROM memory_vector_units u
      JOIN entities e ON e.id=u.owner_id WHERE u.job_id=? AND u.record_kind='node' AND e.type='entity'`,
      )
      .get(second.job_id)!;
    expect(pendingReuse.state).toBe("pending");
    expect(pendingReuse.receipt_json).not.toBeNull();
    db.query(
      `UPDATE memory_vector_units SET state='failed',error_code='fixture_nonshared_claim'
      WHERE job_id=? AND record_kind='node' AND owner_id IN (SELECT id FROM entities WHERE type='memory_atom')`,
    ).run(second.job_id);
    db.query(
      "UPDATE memory_projection_jobs SET next_stage='node_vectors' WHERE job_id=?",
    ).run(second.job_id);
    db.close();
    expect(
      (await memory.advanceNextMemoryProjection({ context }))?.node_vectors
        .state,
    ).toBe("partial");
    expect(projectionInferences).toBe(1);

    db = new Database(graphPath);
    const reusedNode = db
      .query<
        { owner_id: string; owner_revision: string; receipt_json: string },
        [string]
      >(
        `SELECT u.owner_id,u.owner_revision,u.receipt_json FROM memory_vector_units u
      JOIN entities e ON e.id=u.owner_id WHERE u.job_id=? AND u.record_kind='node' AND e.type='entity'`,
      )
      .get(second.job_id)!;
    const vectorKey = (
      JSON.parse(reusedNode.receipt_json).vector_keys as string[]
    )[0]!;
    db.transaction(() => {
      for (let index = 0; index < 257; index += 1) {
        const suffix = String(index).padStart(3, "0");
        const episodeId = `excluded-episode-${suffix}`,
          revision = `excluded-revision-${suffix}`;
        const jobId = `excluded-job-${suffix}`,
          sourceId = `excluded-source-${suffix}`;
        const observedAt = new Date(
          Date.parse("2020-01-01T00:00:00.000Z") + index * 1_000,
        ).toISOString();
        db.query(
          `INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,conversation_session_id,conversation_turn_id,conversation_start,conversation_end,project_id,origin_kind,status,source_hash,created_at,updated_at)
          VALUES(?,?,?,?,'fixture-turn',?,?,NULL,'user_input','active',?,?,?)`,
        ).run(
          episodeId,
          `fixture:${suffix}`,
          revision,
          `excluded-session-${suffix}`,
          observedAt,
          observedAt,
          "d".repeat(64),
          observedAt,
          observedAt,
        );
        db.query(
          `INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at)
          VALUES(?,?,?,'fixture',?,'fixture','low','[]',?,?,?,?,?,?)`,
        ).run(
          jobId,
          episodeId,
          revision,
          generation.generationId,
          JSON.stringify({
            state: "complete",
            completed_units: 1,
            total_units: 1,
          }),
          JSON.stringify({
            state: "complete",
            completed_units: 1,
            total_units: 1,
          }),
          JSON.stringify({
            state: "complete",
            completed_units: 0,
            total_units: 0,
          }),
          JSON.stringify({
            state: "complete",
            completed_units: 1,
            total_units: 1,
          }),
          JSON.stringify({
            state: "complete",
            completed_units: 1,
            total_units: 1,
          }),
          observedAt,
        );
        db.query(
          `INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis)
          VALUES(?,?,?,'conversation',?,?,'fixture-part','/text',0,4,?,'user','user_input',?,'user_statement')`,
        ).run(
          sourceId,
          episodeId,
          revision,
          `excluded-session-${suffix}`,
          `excluded-message-${suffix}`,
          "d".repeat(64),
          observedAt,
        );
        db.query(
          "INSERT INTO entity_mentions(entity_id,source_id,episode_id,revision) VALUES(?,?,?,?)",
        ).run(reusedNode.owner_id, sourceId, episodeId, revision);
        db.query(
          `INSERT INTO memory_vector_units(unit_id,job_id,record_kind,owner_id,owner_revision,project_id,origin_kind,projection_text,state,receipt_json,source_ids_json)
          VALUES(?,?,'node',?,?,NULL,'user_input','fixture','complete',?,?)`,
        ).run(
          `excluded-unit-${suffix}`,
          jobId,
          reusedNode.owner_id,
          reusedNode.owner_revision,
          JSON.stringify({
            generation: generation.generationId,
            embedding_version: generation.embedding!.version,
            vector_keys: [vectorKey],
            row_count: 1,
          }),
          JSON.stringify([sourceId]),
        );
      }
    })();
    const memberships = db
      .query<{ session_id: string; observed_at: string }, [string]>(
        `
      SELECT DISTINCT s.conversation_session_id session_id,s.observed_at FROM memory_vector_units u
      JOIN memory_projection_jobs j ON j.job_id=u.job_id
      JOIN json_each(u.source_ids_json) refs JOIN memory_chunk_sources s ON s.source_id=refs.value
      JOIN entity_mentions m ON m.entity_id=u.owner_id AND m.source_id=s.source_id
      WHERE u.owner_id=? AND u.record_kind='node' AND u.state='complete' ORDER BY julianday(s.observed_at),s.source_id
    `,
      )
      .all(reusedNode.owner_id);
    db.close();
    const scoped = async (
      sessionId: string,
      time?: { from: string; to: string; basis: "conversation" },
    ) => {
      const asOf = new Date(Date.now() + 1_000).toISOString();
      const searched = await vectors.searchGenerationVectors({
        generation,
        phrases: ["Luna"],
        scope: "current_session",
        projectFilter: "unassigned",
        projectIds: [],
        runtimeProjectId: null,
        runtimeSessionId: sessionId,
        sessionIds: [],
        asOf,
        time,
        includeInternal: false,
        deadlineAt: Date.now() + 5_000,
      });
      const currentDb = new Database(graphPath, { readonly: true });
      try {
        return vectors
          .filterCurrentGenerationVectorMatches(
            currentDb,
            generation,
            searched,
            {
              scope: "current_session",
              projectFilter: "unassigned",
              projectIds: [],
              runtimeProjectId: null,
              runtimeSessionId: sessionId,
              sessionIds: [],
              asOf,
              time,
              includeInternal: false,
            },
          )
          .nodes.find((node) => node.ownerId === reusedNode.owner_id);
      } finally {
        currentDb.close();
      }
    };
    const observedA = memberships.find(
      (row) => row.session_id === "vector-reuse-a",
    )!.observed_at;
    const observedB = memberships.find(
      (row) => row.session_id === "vector-reuse-b",
    )!.observed_at;
    const around = (value: string) => ({
      from: new Date(Date.parse(value) - 1).toISOString(),
      to: new Date(Date.parse(value) + 1).toISOString(),
      basis: "conversation" as const,
    });
    const currentA = await scoped("vector-reuse-a");
    const currentB = await scoped("vector-reuse-b");
    expect(
      memberships.filter((row) =>
        row.session_id.startsWith("excluded-session-"),
      ).length,
    ).toBe(257);
    expect(currentA?.vectorKey).toBe(currentB?.vectorKey);
    expect((await scoped("vector-reuse-a", around(observedA)))?.vectorKey).toBe(
      currentA?.vectorKey,
    );
    expect((await scoped("vector-reuse-b", around(observedB)))?.vectorKey).toBe(
      currentB?.vectorKey,
    );
    expect(projectionInferences).toBe(1);
    expect(
      (await (await legacyConnection.openTable("butler_memory")).schema()).fields
        .some((field) => field.name === "source_kind"),
    ).toBe(true);

    const eventRecall = await memory.recallMemory({
      context,
      cue: "semantic interval query",
      includeVector: true,
      includeInternal: false,
      limit: 6,
      scope: "all_user_sessions",
      projectFilter: "unassigned",
      projectIds: [],
      sessionIds: ["vector-reuse-a", "vector-reuse-b"],
      asOf: new Date(Date.now() + 1_000).toISOString(),
      time: {
        from: "2026-01-10T00:00:00.000Z",
        to: "2026-01-20T00:00:00.000Z",
        basis: "event",
      },
      runtime: {
        sessionId: "vector-event-query",
        turnId: "vector-event-turn",
        currentUserMessage: "semantic interval query",
        nativeOperationId: "vector-event-operation",
        projectId: null,
      },
    });
    const firstSourceIds = JSON.parse(currentA!.sourceRefsJson) as string[];
    const secondSourceIds = JSON.parse(currentB!.sourceRefsJson) as string[];
    const eventEvidence = eventRecall.results.flatMap(
      (result) => result.evidence,
    );
    expect(eventRecall.coverage.vectors.candidates).toBeGreaterThan(0);
    expect(
      eventRecall.results.some((result) =>
        result.summary.includes("현재 일정"),
      ),
    ).toBe(true);
    expect(
      eventEvidence.some((evidence) =>
        secondSourceIds.includes(Buffer.from(evidence.source_ref.split(":")[3]!, "base64url").toString("utf8")),
      ),
    ).toBe(true);
    expect(
      eventEvidence.every(
        (evidence) => !firstSourceIds.includes(evidence.source_ref),
      ),
    ).toBe(true);
    expect(projectionInferences).toBe(1);

    const canonical = new Database(
      join(butlerData, "runtime", "conversation-store.sqlite"),
    );
    canonical
      .query("UPDATE conversation_parts SET content_json=? WHERE message_id=?")
      .run(
        JSON.stringify({ text: "Luna's recorded name changed." }),
        firstSource.request_message_id,
      );
    canonical.close();
    const store = new AgentConversationStore({ butlerData });
    store.writeTurnOutcome({
      sessionId: "vector-reuse-a",
      turnId: "vector-reuse-turn-a",
      generation: 2,
      outcome: "delivered",
      requestMessageId: firstSource.request_message_id,
      publicAssistantMessageId: firstSource.assistant_message_id,
    });
    store.close();
    await memory.ingestConversationMemory({
      context,
      source: {
        kind: "conversation_turn",
        session_id: "vector-reuse-a",
        turn_id: "vector-reuse-turn-a",
        outcome_generation: 2,
      },
    });

    const searched = await vectors.searchGenerationVectors({
      generation,
      phrases: ["Luna"],
      scope: "all_user_sessions",
      projectFilter: "unassigned",
      projectIds: [],
      runtimeProjectId: null,
      runtimeSessionId: "vector-reuse-b",
      sessionIds: ["vector-reuse-b"],
      asOf: new Date(Date.now() + 1_000).toISOString(),
      includeInternal: false,
      deadlineAt: Date.now() + 5_000,
    });
    db = new Database(graphPath, { readonly: true });
    const current = vectors.filterCurrentGenerationVectorMatches(
      db,
      generation,
      searched,
      {
        scope: "all_user_sessions",
        projectFilter: "unassigned",
        projectIds: [],
        runtimeProjectId: null,
        runtimeSessionId: "vector-reuse-b",
        sessionIds: ["vector-reuse-b"],
        asOf: new Date(Date.now() + 1_000).toISOString(),
        includeInternal: false,
      },
    );
    expect(current.nodes.map((node) => node.ownerId)).toContain(
      reusedNode.owner_id,
    );
    expect(JSON.parse(reusedNode.receipt_json).inference_reused).toBe(true);
    expect(
      current.nodes.find((node) => node.ownerId === reusedNode.owner_id)
        ?.conversationSessionId,
    ).toBe("vector-reuse-b");
    db.close();
    expect(await scoped("vector-reuse-a")).toBeUndefined();
    expect((await scoped("vector-reuse-b"))?.vectorKey).toBe(
      currentB?.vectorKey,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("episode registration faults route through normal advance and preserve completed node stage", async () => {
  const butlerData = mkdtempSync(
    join(tmpdir(), "butler-memory-episode-registration-"),
  );
  roots.push(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const memory =
    await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  const context = {
    butlerData,
    target: {
      kind: "active" as const,
      expected_generation: descriptor.generation_id,
    },
    signal: new AbortController().signal,
  };
  const socketPath = process.env.EMBED_SOCKET!;
  const server = createServer((socket) => {
    let payload = "";
    socket.on("data", (chunk) => {
      payload += chunk.toString();
      if (!payload.includes("\n")) return;
      const request = JSON.parse(payload.trim()) as { texts: string[] };
      socket.end(
        `${JSON.stringify({
          embeddings: request.texts.map(() => [1, 0]),
          token_counts: request.texts.map(() => 2),
          embedded_texts: request.texts,
          omitted_count: 0,
          metadata: {
            model: "test/bge-m3",
            dimension: 2,
            pooling: "cls",
            normalize: true,
            version: "a".repeat(64),
            max_tokens: 8192,
            transformers_version: "test",
            node_runtime_version: process.version,
            bun_runtime_version: Bun.version,
            tokenizer_asset_sha256: "b".repeat(64),
            model_asset_sha256: "c".repeat(64),
          },
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    const store = new AgentConversationStore({ butlerData });
    const turn = store.beginTurn({
      gateway: "app",
      externalSessionId: "episode-stage",
      sessionId: "episode-stage",
      projectId: null,
      actor: "user",
      turnId: "episode-stage-turn",
    });
    const user = store.appendUserMessage({
      sessionId: turn.session_id,
      turnId: turn.id,
      text: "",
      originKind: "user_input",
      originRef: "test:episode-stage:user",
      parts: Array.from({ length: 80 }, (_, index) => ({
        kind: "text" as const,
        contentJson: { text: `Luna stage-${index} ${"x".repeat(100)}` },
      })),
    });
    const assistant = store.appendAssistantMessage({
      sessionId: turn.session_id,
      turnId: turn.id,
      text: "Noted.",
      originKind: "assistant_public",
      originRef: "test:episode-stage:assistant",
    });
    store.finalizeTurn({
      turnId: turn.id,
      status: "complete",
      outcomeCapsule: {
        sessionId: turn.session_id,
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
    const source = {
      kind: "conversation_turn" as const,
      session_id: turn.session_id,
      turn_id: turn.id,
      outcome_generation: 1,
    };
    const job = await memory.ingestConversationMemory({ context, source });
    transformExtractionOutput = (output, input) => {
      output.summary = null;
      const text = input.source_units.map((unit: any) => unit.text).join("");
      if (output.nodes[0])
        output.nodes[0].aliases = output.nodes[0].aliases.filter((alias: any) =>
          text.includes(alias.text),
        );
      const candidate = input.candidates.find(
        (item: any) => item.type === "entity" && item.aliases.includes("Luna"),
      );
      if (candidate && output.nodes[0])
        output.nodes[0].resolution = {
          kind: "reuse",
          node_ref: candidate.ref,
          reason: "explicit_alias",
          evidence: [
            output.nodes[0].evidence[0],
            {
              unit_ref: candidate.evidence[0].ref,
              quote: "Luna",
              occurrence: 0,
            },
          ],
        };
    };
    const graphPath = join(
      butlerData,
      "cognition",
      "memory",
      "generations",
      descriptor.generation_id,
      "graph.sqlite",
    );
    let completedSemanticLeaf = false;
    for (
      let attempt = 0;
      attempt < 16 && !completedSemanticLeaf;
      attempt += 1
    ) {
      const scheduled = new Database(graphPath);
      scheduled
        .query(
          "UPDATE memory_projection_jobs SET next_stage='semantic_graph' WHERE job_id=?",
        )
        .run(job.job_id);
      scheduled.close();
      const progress = await memory.advanceNextMemoryProjection({ context });
      expect(progress?.job_id).toBe(job.job_id);
      const observed = new Database(graphPath, { readonly: true });
      completedSemanticLeaf =
        Number(
          observed
            .query<
              { n: number },
              [string]
            >("SELECT COUNT(*) n FROM memory_projection_windows WHERE job_id=? AND state='complete'")
            .get(job.job_id)!.n,
        ) > 0;
      observed.close();
    }
    const semanticDebug = new Database(graphPath, { readonly: true });
    const semanticStates = semanticDebug
      .query<
        Record<string, unknown>,
        [string]
      >("SELECT state,error_code,COUNT(*) count FROM memory_projection_windows WHERE job_id=? GROUP BY state,error_code")
      .all(job.job_id);
    semanticDebug.close();
    expect({ completedSemanticLeaf, semanticStates }).toMatchObject({
      completedSemanticLeaf: true,
    });
    let db = new Database(graphPath);
    expect(
      Number(
        db
          .query<
            { n: number },
            [string]
          >("SELECT COUNT(*) n FROM memory_projection_windows WHERE job_id=? AND state='pending'")
          .get(job.job_id)!.n,
      ),
    ).toBeGreaterThan(0);
    db.query(
      "UPDATE memory_projection_jobs SET next_stage='node_vectors' WHERE job_id=?",
    ).run(job.job_id);
    db.close();
    expect(
      (await memory.advanceNextMemoryProjection({ context }))?.node_vectors
        .state,
    ).toBe("complete");
    db = new Database(graphPath);
    db.exec(`CREATE TRIGGER fail_episode_vector_registration BEFORE INSERT ON memory_vector_units
      WHEN NEW.record_kind='episode' BEGIN SELECT RAISE(ABORT,'memory_write_busy'); END`);
    db.query(
      "UPDATE memory_projection_jobs SET next_stage='semantic_graph' WHERE job_id=?",
    ).run(job.job_id);
    db.close();
    await memory.advanceNextMemoryProjection({ context });
    db = new Database(graphPath, { readonly: true });
    let stages = db
      .query<
        { node_vectors_state: string; episode_vectors_state: string },
        [string]
      >("SELECT node_vectors_state,episode_vectors_state FROM memory_projection_jobs WHERE job_id=?")
      .get(job.job_id)!;
    expect(JSON.parse(stages.node_vectors_state).state).toBe("complete");
    expect(JSON.parse(stages.episode_vectors_state)).toEqual({
      state: "pending",
      blocked_by: "memory_write_busy",
    });
    db.close();
    db = new Database(graphPath);
    db.exec("DROP TRIGGER fail_episode_vector_registration");
    db.close();
    await memory.ingestConversationMemory({
      context,
      source,
      completionJobId: "episode-stage-retry",
    });
    db = new Database(graphPath, { readonly: true });
    stages = db
      .query<
        { node_vectors_state: string; episode_vectors_state: string },
        [string]
      >("SELECT node_vectors_state,episode_vectors_state FROM memory_projection_jobs WHERE job_id=?")
      .get(job.job_id)!;
    expect(JSON.parse(stages.node_vectors_state).state).toBe("complete");
    expect(JSON.parse(stages.episode_vectors_state)).toEqual({
      state: "pending",
      blocked_by: null,
    });
    expect(
      Number(
        db
          .query<
            { n: number },
            [string]
          >("SELECT COUNT(*) n FROM memory_vector_units WHERE job_id=? AND record_kind='episode' AND state='pending'")
          .get(job.job_id)!.n,
      ),
    ).toBeGreaterThan(0);
    db.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("legacy allocation guard reaches normal migration recovery without changing preserved evidence", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-memory-legacy-owner-"));
  roots.push(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const memory =
    await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  const context = {
    butlerData,
    target: {
      kind: "active" as const,
      expected_generation: descriptor.generation_id,
    },
    signal: new AbortController().signal,
  };
  const graphPath = join(
    butlerData,
    "cognition",
    "memory",
    "generations",
    descriptor.generation_id,
    "graph.sqlite",
  );
  const jobs = [];
  for (let index = 0; index < 2; index += 1) {
    const source = seedTurn(
      butlerData,
      `legacy-session-${index}`,
      `legacy-turn-${index}`,
      `루나 Luna legacy ${index}`,
      "확인했습니다.",
      1,
      undefined,
      null,
    );
    const job = await memory.ingestConversationMemory({ context, source });
    await advanceUntilSemanticTerminal(memory, context, job.job_id);
    const closed = new Database(graphPath);
    closed
      .query(
        "UPDATE memory_vector_units SET state='failed',error_code='fixture_closed' WHERE job_id=?",
      )
      .run(job.job_id);
    closed
      .query(
        "UPDATE memory_projection_jobs SET node_vectors_state=?,episode_vectors_state=?,hot_cache_state=? WHERE job_id=?",
      )
      .run(
        JSON.stringify({
          state: "failed",
          code: "fixture_closed",
          retryable: false,
          next_attempt_at: null,
        }),
        JSON.stringify({
          state: "failed",
          code: "fixture_closed",
          retryable: false,
          next_attempt_at: null,
        }),
        JSON.stringify({
          state: "complete",
          completed_units: 1,
          total_units: 1,
        }),
        job.job_id,
      );
    closed.close();
    jobs.push(job);
  }
  const failedSource = seedTurn(
    butlerData,
    "legacy-session-failed",
    "legacy-turn-failed",
    "루나 Luna legacy failed",
    "확인했습니다.",
    1,
    undefined,
    null,
  );
  const failedJob = await memory.ingestConversationMemory({
    context,
    source: failedSource,
  });
  transformExtractionOutput = (output) => {
    output.nodes[0].evidence[0].quote = "absent quote";
  };
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const selected = await memory.advanceNextMemoryProjection({ context });
    const observed = new Database(graphPath, { readonly: true });
    const row = observed
      .query<
        { attempt_count: number },
        [string]
      >("SELECT attempt_count FROM memory_projection_windows WHERE job_id=?")
      .get(failedJob.job_id);
    observed.close();
    if (row?.attempt_count === 1) break;
    expect(selected).not.toBeNull();
  }
  transformExtractionOutput = null;
  let db = new Database(graphPath);
  const completedPreimages = jobs.map(
    (job) =>
      db
        .query<
          {
            window_ref: string;
            normalized_plan_json: string;
            output_json: string;
            provider_evidence_json: string;
          },
          [string]
        >(
          `
    SELECT window_ref,normalized_plan_json,output_json,provider_evidence_json FROM memory_projection_windows WHERE job_id=? AND state='complete'
  `,
        )
        .get(job.job_id)!,
  );
  const failedPreimage = db
    .query<
      {
        window_ref: string;
        output_json: string;
        provider_evidence_json: string;
      },
      [string]
    >(
      `
    SELECT window_ref,output_json,provider_evidence_json FROM memory_projection_windows WHERE job_id=?
  `,
    )
    .get(failedJob.job_id)!;
  expect(failedPreimage.output_json).not.toBeNull();
  expect(failedPreimage.provider_evidence_json).not.toBeNull();
  db.query(
    "UPDATE memory_vector_units SET state='failed',error_code='fixture_closed' WHERE job_id=?",
  ).run(failedJob.job_id);
  db.query(
    "UPDATE memory_projection_jobs SET node_vectors_state=?,episode_vectors_state=?,hot_cache_state=? WHERE job_id=?",
  ).run(
    JSON.stringify({
      state: "failed",
      code: "fixture_closed",
      retryable: false,
      next_attempt_at: null,
    }),
    JSON.stringify({
      state: "failed",
      code: "fixture_closed",
      retryable: false,
      next_attempt_at: null,
    }),
    JSON.stringify({ state: "complete", completed_units: 1, total_units: 1 }),
    failedJob.job_id,
  );
  db.query(
    "UPDATE memory_projection_windows SET state='failed',next_attempt_at=NULL,input_json=NULL,input_sha256=NULL,input_migration_note=NULL WHERE window_ref=?",
  ).run(failedPreimage.window_ref);
  const vectorFailurePreimage = failedVectorUnits(graphPath);
  expect(vectorFailurePreimage.length).toBeGreaterThan(0);
  db.query(
    "DELETE FROM memory_state WHERE key='t3_legacy_failure_migration'",
  ).run();
  db.exec(
    "DROP INDEX idx_windows_due; ALTER TABLE memory_projection_windows DROP COLUMN parent_window_ref; ALTER TABLE memory_projection_windows DROP COLUMN next_attempt_at; ALTER TABLE memory_vector_units DROP COLUMN attempt_count",
  );
  db.close();
  expect(failedVectorUnits(graphPath)).toEqual(vectorFailurePreimage);
  const legacySchema = new Database(graphPath, { readonly: true });
  expect(
    legacySchema
      .query<{ name: string }, []>("PRAGMA table_info(memory_vector_units)")
      .all()
      .some((column) => column.name === "attempt_count"),
  ).toBe(false);
  legacySchema.close();
  expect(
    assertAllocatedProjectionState(graphPath, 3, failedPreimage.window_ref),
  ).toMatchObject({
    jobs: 3,
    windows: 3,
    complete: 2,
    failed: 1,
    split_children: 0,
  });
  let recovered = false;
  for (let attempt = 0; attempt < 32 && !recovered; attempt += 1) {
    await memory.advanceNextMemoryProjection({ context });
    const observed = new Database(graphPath, { readonly: true });
    recovered =
      observed
        .query<
          { state: string },
          [string]
        >("SELECT state FROM memory_projection_windows WHERE window_ref=?")
        .get(failedPreimage.window_ref)?.state === "complete";
    observed.close();
  }
  expect(recovered).toBe(true);
  db = new Database(graphPath, { readonly: true });
  for (const preimage of completedPreimages)
    expect(
      db
        .query<
          {
            normalized_plan_json: string;
            output_json: string;
            provider_evidence_json: string;
          },
          [string]
        >(
          `
    SELECT normalized_plan_json,output_json,provider_evidence_json FROM memory_projection_windows WHERE window_ref=?
  `,
        )
        .get(preimage.window_ref),
    ).toEqual({
      normalized_plan_json: preimage.normalized_plan_json,
      output_json: preimage.output_json,
      provider_evidence_json: preimage.provider_evidence_json,
    });
  expect(
    db
      .query<
        {
          output_json: string;
          provider_evidence_json: string;
          error_code: string;
        },
        [string]
      >(
        `
    SELECT output_json,provider_evidence_json,error_code FROM memory_projection_attempts
    WHERE window_ref=? AND attempt_count=1 AND state='failed'
  `,
      )
      .get(failedPreimage.window_ref),
  ).toEqual({
    output_json: failedPreimage.output_json,
    provider_evidence_json: failedPreimage.provider_evidence_json,
    error_code: "memory_extract_invalid_quote",
  });
  expect(
    db
      .query<
        { state: string; input_migration_note: string },
        [string]
      >("SELECT state,input_migration_note FROM memory_projection_windows WHERE window_ref=?")
      .get(failedPreimage.window_ref),
  ).toEqual({
    state: "complete",
    input_migration_note: "legacy_input_unavailable",
  });
  db.close();
  db = new Database(graphPath);
  expect(
    db
      .query<{ name: string }, []>("PRAGMA table_info(memory_vector_units)")
      .all()
      .some((column) => column.name === "attempt_count"),
  ).toBe(true);
  const retryUnit = db
    .query<
      { unit_id: string },
      []
    >("SELECT unit_id FROM memory_vector_units ORDER BY unit_id LIMIT 1")
    .get()!;
  db.query(
    "UPDATE memory_vector_units SET state='pending',attempt_count=1,error_code='fixture_pending_retry' WHERE unit_id=?",
  ).run(retryUnit.unit_id);
  db.close();
  expect(failedVectorUnits(graphPath)).toContainEqual({
    unit_id: retryUnit.unit_id,
    error_code: "fixture_pending_retry",
  });
  db = new Database(graphPath);
  db.query(
    "INSERT INTO memory_projection_windows(window_ref,job_id,ordinal,source_refs_json,state,parent_window_ref) VALUES('unallocated-child',?,99,'[]','pending',?)",
  ).run(failedJob.job_id, failedPreimage.window_ref);
  db.close();
  expect(() => assertAllocatedProjectionState(graphPath, 3)).toThrow(
    "memory projection exceeded allocated source windows",
  );
});

test("internal or unknown canonical completion is drained without extraction", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-memory-internal-"));
  roots.push(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const cases = [
    {
      turnId: "turn-internal",
      userOrigin: "internal_control" as const,
      assistantOrigin: "assistant_public" as const,
    },
    {
      turnId: "turn-unknown",
      userOrigin: "user_input" as const,
      assistantOrigin: "unknown" as const,
    },
  ];
  const { pollIteration } =
    await import("../../packages/butler-agent/src/agent/cognition/memory/scripts/sync-consumer.ts");
  for (const item of cases) {
    const source = seedTurn(
      butlerData,
      `session-${item.turnId}`,
      item.turnId,
      "synthetic control content",
      "synthetic internal answer",
      1,
      {
        user: item.userOrigin,
        assistant: item.assistantOrigin,
      },
    );
    publishConversationCompletionObservation({
      butlerData,
      runtimeSessionId: `butler/${item.turnId}`,
      conversationSessionId: source.session_id,
      conversationTurnId: source.turn_id,
      inboundMessageId: source.request_message_id,
      outboundMessageId: source.assistant_message_id,
      outcomeGeneration: source.outcome_generation,
      completedAt: new Date().toISOString(),
    });
    expect((await pollIteration({ butlerData })).action).toBe("processed");
    expect(peek(butlerData)).toBeNull();
  }
  expect(extractionInputs).toHaveLength(0);
  const graph = new Database(
    join(
      butlerData,
      "cognition",
      "memory",
      "generations",
      descriptor.generation_id,
      "graph.sqlite",
    ),
    { readonly: true },
  );
  try {
    expect(
      graph
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) count FROM memory_chunks")
        .get()!.count,
    ).toBe(0);
  } finally {
    graph.close();
  }
});

test("recovered no-turn sources reach native recall through batch source hydration", async () => {
  const butlerData = mkdtempSync(
    join(tmpdir(), "butler-memory-recovered-recall-"),
  );
  roots.push(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const memory =
    await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  const store = new AgentConversationStore({ butlerData });
  store.beginTurn({
    gateway: "app",
    externalSessionId: "recovered-recall",
    sessionId: "recovered-recall",
    actor: "user",
    turnId: "anchor",
  });
  const messages = [
    store.appendUserMessage({
      sessionId: "recovered-recall",
      turnId: null,
      text: "루나 Luna recovered-user marker",
      status: "failed",
      provenance: "recovered",
      originKind: "user_input",
      originRef: "test",
    }),
    store.appendUserMessage({
      sessionId: "recovered-recall",
      turnId: null,
      text: "루나 Luna compacted-user marker",
      status: "compacted",
      provenance: "imported",
      originKind: "user_input",
      originRef: "test",
    }),
    store.appendAssistantMessage({
      sessionId: "recovered-recall",
      turnId: null,
      text: "루나 Luna recovered-assistant marker",
      status: "complete",
      provenance: "recovered",
      originKind: "assistant_public",
      originRef: "test",
    }),
  ];
  store.close();
  const context = {
    butlerData,
    target: {
      kind: "active" as const,
      expected_generation: descriptor.generation_id,
    },
    signal: new AbortController().signal,
  };
  const jobs = [];
  for (const message of messages) {
    const sourceHash = new Bun.CryptoHasher("sha256")
      .update(
        JSON.stringify(
          message.parts.map((part) => [part.id, part.content_json]),
        ),
      )
      .digest("hex");
    jobs.push(
      await memory.ingestConversationMemory({
        context,
        source: {
          kind: "conversation_message",
          session_id: message.session_id,
          message_id: message.id,
          source_hash: sourceHash,
        },
      }),
    );
  }
  for (let count = 0; count < 24; count += 1) {
    const graph = new Database(
      join(
        butlerData,
        "cognition",
        "memory",
        "generations",
        descriptor.generation_id,
        "graph.sqlite",
      ),
      { readonly: true },
    );
    const complete = jobs.every(
      (job) =>
        JSON.parse(
          graph
            .query<
              { semantic_graph_state: string },
              [string]
            >("SELECT semantic_graph_state FROM memory_projection_jobs WHERE job_id=?")
            .get(job.job_id)!.semantic_graph_state,
        ).state === "complete",
    );
    graph.close();
    if (complete) break;
    expect(
      await memory.advanceNextMemoryProjection({ context }),
    ).not.toBeNull();
  }
  const recalled = await memory.recallMemory({
    context,
    cue: "Luna",
    includeVector: false,
    includeInternal: false,
    limit: 6,
    scope: "all_user_sessions",
    projectFilter: "unassigned",
    projectIds: [],
    sessionIds: ["recovered-recall"],
    asOf: new Date(Date.now() + 1_000).toISOString(),
    runtime: {
      sessionId: "recovered-recall",
      turnId: "native-recall",
      currentUserMessage: "Luna",
      nativeOperationId: "recovered-native-recall",
      projectId: null,
    },
  });
  const excerpts = recalled.results.flatMap((result) =>
    result.evidence.map((evidence) => evidence.excerpt),
  );
  expect(excerpts.some((text) => text.includes("recovered-user marker"))).toBe(
    true,
  );
  expect(excerpts.some((text) => text.includes("compacted-user marker"))).toBe(
    true,
  );
  expect(
    excerpts.some((text) => text.includes("recovered-assistant marker")),
  ).toBe(true);
});

test("extractor candidates exclude claims from a different canonical scope", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-memory-scope-"));
  roots.push(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const memory =
    await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  const context = {
    butlerData,
    target: {
      kind: "active" as const,
      expected_generation: descriptor.generation_id,
    },
    signal: new AbortController().signal,
  };
  const episodes = [
    seedTurn(
      butlerData,
      "global-alias",
      "global-alias-turn",
      "내 고양이 루나의 영어 이름은 Luna야.",
      "Noted.",
      1,
      undefined,
      null,
    ),
    seedTurn(
      butlerData,
      "global-claim",
      "global-claim-turn",
      "Luna likes the blue ball.",
      "Noted.",
      1,
      undefined,
      null,
    ),
    seedTurn(
      butlerData,
      "project-claim",
      "project-claim-turn",
      "Luna likes the blue ball.",
      "Noted.",
      1,
    ),
    seedTurn(
      butlerData,
      "global-repeat",
      "global-repeat-turn",
      "Luna likes the blue ball.",
      "Noted.",
      1,
      undefined,
      null,
    ),
  ];
  for (const source of episodes) {
    const job = await memory.ingestConversationMemory({ context, source });
    await advanceUntilSemanticTerminal(memory, context, job.job_id);
  }
  const projectCandidates = extractionInputs[2]!.candidates;
  expect(
    projectCandidates.some((candidate: any) => candidate.type === "entity"),
  ).toBe(true);
  expect(
    projectCandidates.some(
      (candidate: any) =>
        candidate.type === "preference" && candidate.scope === "user",
    ),
  ).toBe(false);
  const globalCandidates = extractionInputs[3]!.candidates.filter(
    (candidate: any) => candidate.type === "preference",
  );
  expect(globalCandidates.length).toBeGreaterThan(0);
  expect(
    globalCandidates.every(
      (candidate: any) =>
        candidate.scope === "user" && candidate.project_id === null,
    ),
  ).toBe(true);
});

test("explicit same-name and confusable creates remain distinct identities", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-memory-identity-create-"));
  roots.push(butlerData);
  const embeddingServer = await startCheckedEmbeddingServer(process.env.EMBED_SOCKET!);
  try {
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const memory = await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  const context = {
    butlerData,
    target: { kind: "active" as const, expected_generation: descriptor.generation_id },
    signal: new AbortController().signal,
  };
  const baselineSource = seedTurn(
    butlerData, "identity-create-session", "identity-create-baseline",
    "내 고양이 루나의 영어 이름은 Luna야.", "Noted.", 1,
  );
  const baselineJob = await memory.ingestConversationMemory({ context, source: baselineSource });
  expect((await advanceUntilSemanticTerminal(memory, context, baselineJob.job_id))?.semantic_graph.state)
    .toBe("complete");

  const labels = ["Luna", "Lúna", "Lunа"] as const;
  transformExtractionOutput = (output, input) => {
    if (!Array.isArray(input.parts) || !input.parts.some((item: any) => item.text.includes("separate labels"))) return;
    const evidence = input.parts.filter((item: any) => item.text.includes("separate labels")).map((item: any) => item.id);
    for (const key of Object.keys(output)) delete output[key];
    Object.assign(output, {
      status: "processed",
      entities: labels.map((name) => ({ name, evidence })),
      items: [],
      attributes: [],
    });
  };
  const createText = "Luna, Lúna, and Lunа are separate labels.";
  const createSource = seedTurn(
    butlerData, "identity-create-session", "identity-create-distinct",
    createText, "Recorded separately.", 1,
  );
  const createJob = await memory.ingestConversationMemory({ context, source: createSource });
  expect((await advanceUntilSemanticTerminal(memory, context, createJob.job_id))?.semantic_graph.state)
    .toBe("complete");

  const graphPath = join(
    butlerData, "cognition", "memory", "generations", descriptor.generation_id, "graph.sqlite",
  );
  const graph = new Database(graphPath, { readonly: true });
  const baselineEntity = graph.query<{ id: string; label_original: string }, [string]>(`SELECT e.id,e.label_original
    FROM entities e JOIN entity_mentions m ON m.entity_id=e.id
    JOIN memory_chunks c ON c.memory_chunk_id=m.episode_id
    WHERE c.conversation_turn_id=? AND e.type='entity' AND e.label_original='Luna' LIMIT 1`)
    .get(baselineSource.turn_id)!;
  const createdEntities = graph.query<{ id: string; label_original: string }, [string]>(`SELECT DISTINCT e.id,e.label_original
    FROM entities e JOIN entity_mentions m ON m.entity_id=e.id
    JOIN memory_chunks c ON c.memory_chunk_id=m.episode_id
    WHERE c.conversation_turn_id=? AND e.type='entity' ORDER BY e.label_original,e.id`)
    .all(createSource.turn_id);
  expect(createdEntities.map((row) => row.label_original).sort()).toEqual([...labels].sort());
  const allEntityIds = [baselineEntity.id, ...createdEntities.map((row) => row.id)];
  expect(new Set(allEntityIds).size).toBe(4);
  const aliases = graph.query<{
    entity_id: string; surface_original: string; nfc_key: string; folded_key: string; source_id: string;
  }, [string, string, string, string]>(`SELECT entity_id,surface_original,nfc_key,folded_key,source_id
    FROM entity_aliases WHERE entity_id IN (?,?,?,?) ORDER BY entity_id,surface_original`)
    .all(allEntityIds[0]!, allEntityIds[1]!, allEntityIds[2]!, allEntityIds[3]!);
  expect(new Set(aliases.map((row) => row.entity_id))).toEqual(new Set(allEntityIds));
  const sourceRows = graph.query<any, [string, string]>(`SELECT s.* FROM memory_chunk_sources s
    JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id
    WHERE c.conversation_turn_id IN (?,?) ORDER BY c.conversation_turn_id,s.source_id`)
    .all(baselineSource.turn_id, createSource.turn_id);
  graph.close();
  const { canonicalConversationProjectionInventory, hydrateSource, memorySourceInventoryHash } = await import(
    "../../packages/butler-agent/src/agent/cognition/memory/projection/source.ts"
  );
  const sources = sourceRows.map((row) => {
    const hydrated = hydrateSource(butlerData, row);
    return {
      source_id: row.source_id,
      episode_id: row.episode_id,
      revision: row.revision,
      content_hash: row.content_hash,
      conversation_message_id: row.conversation_message_id,
      part_id: row.part_id,
      scalar_pointer: row.scalar_pointer,
      byte_start: row.byte_start,
      byte_end: row.byte_end,
      span_text: hydrated.text,
      full_scalar_text: hydrated.scalar_text ?? hydrated.text,
      full_scalar_bytes: Buffer.byteLength(hydrated.scalar_text ?? hydrated.text, "utf8"),
      full_scalar_sha256: hydrated.source_hash,
    };
  });
  const inventoryAsOf = new Date().toISOString();
  const canonicalInventory = canonicalConversationProjectionInventory({
    butlerData, asOf: inventoryAsOf, deadlineAt: Date.now() + 30_000,
    scope: "all_user_sessions", currentSessionId: "", currentProjectId: null,
    sessionIds: [], projectFilter: "any", projectIds: [],
  });
  if (!canonicalInventory.available || canonicalInventory.partial) {
    throw new Error("identity owner canonical source inventory is unavailable");
  }
  const sourceInventory = {
    schema: "butler.memory-source-inventory.v1", as_of: inventoryAsOf,
    origin: { version: "conversation-origin-v1" }, exclusions: canonicalInventory.exclusions,
    entries: canonicalInventory.entries, typed: [], typed_lifecycle: [], history: [],
  };
  writeT6OwnerEvidence("t6-b-identity-owner-result.json", {
    schema: "butler.memory-owner-result-evidence.v1",
    result_id: `identity-create:${createJob.job_id}`,
    generation_id: descriptor.generation_id,
    status: "ok",
    source_handles: [],
    observations: [],
    raw_facts: {
      baseline_job_id: baselineJob.job_id,
      create_job_id: createJob.job_id,
      baseline_entity: baselineEntity,
      created_entities: createdEntities,
      aliases,
      sources,
      source_inventory: sourceInventory,
      source_inventory_hash: memorySourceInventoryHash(sourceInventory),
      asserted_distinct_ids: allEntityIds,
      asserted_no_merge: new Set(allEntityIds).size === allEntityIds.length,
    },
    implementation_source_files: [
      "packages/butler-agent/src/agent/cognition/memory/projection/plan.ts",
      "packages/butler-agent/src/agent/cognition/memory/projection/identity.ts",
    ].map((path) => ({
      path,
      sha256: createHash("sha256").update(readFileSync(join(process.cwd(), path))).digest("hex"),
    })),
  });
  } finally {
    await new Promise<void>((resolve) => embeddingServer.close(() => resolve()));
  }
});

test("validated ordinary corrections preserve the previous claim and apply through T3 semantics", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-memory-correction-"));
  roots.push(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const memory =
    await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  const context = {
    butlerData,
    target: {
      kind: "active" as const,
      expected_generation: descriptor.generation_id,
    },
    signal: new AbortController().signal,
  };
  const server = createServer((socket) => {
    let payload = "";
    socket.on("data", (chunk) => {
      payload += chunk.toString();
      if (!payload.includes("\n")) return;
      const request = JSON.parse(payload.trim()) as { texts: string[] };
      socket.end(`${JSON.stringify({
        embeddings: request.texts.map(() => [1, 0]), token_counts: request.texts.map(() => 2),
        embedded_texts: request.texts, omitted_count: 0,
        metadata: {
          model: "test/bge-m3", dimension: 2, pooling: "cls", normalize: true,
          version: "a".repeat(64), max_tokens: 8192, transformers_version: "test",
          node_runtime_version: process.version, bun_runtime_version: Bun.version,
          tokenizer_asset_sha256: "b".repeat(64), model_asset_sha256: "c".repeat(64),
        },
      })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(process.env.EMBED_SOCKET!, resolve); });
  try {
  const aliasJob = await memory.ingestConversationMemory({
    context,
    source: seedTurn(
      butlerData,
      "correction-session",
      "correction-alias",
      "내 고양이 루나의 영어 이름은 Luna야.",
      "Noted.",
      1,
    ),
  });
  await advanceUntilSemanticTerminal(memory, context, aliasJob.job_id);
  const priorJob = await memory.ingestConversationMemory({
    context,
    source: seedTurn(
      butlerData,
      "correction-session",
      "correction-prior-claim",
      "Luna likes the blue ball.",
      "Noted.",
      1,
    ),
  });
  await advanceUntilSemanticTerminal(memory, context, priorJob.job_id);
  await advanceUntilHotCacheComplete(memory, context, priorJob.job_id);
  let correctionInput: Record<string, any> | null = null;
  let correctionOutput: Record<string, any> | null = null;
  transformExtractionOutput = (output, input) => {
    const source = input.source_units.find((unit: any) => unit.role === "user");
    if (!source?.text.includes("赤いボール")) return;
    const previousClaim = input.candidates.find(
      (candidate: any) => candidate.type === "preference",
    );
    const luna = input.candidates.find(
      (candidate: any) =>
        candidate.type === "entity" && candidate.aliases.includes("Luna"),
    );
    if (!previousClaim) throw new Error("missing prior claim candidate");
    if (!luna) throw new Error("missing Luna candidate");
    const blue = input.candidates.find((candidate: any) => candidate.ref === previousClaim.claim?.object_ref);
    if (!blue) throw new Error("missing stored blue-ball endpoint candidate");
    expect(previousClaim.claim).toEqual({
      subject_ref: luna.ref, object_ref: blue.ref, relation: "likes",
      polarity: "positive", condition: null,
    });
    expect(luna.claim).toBeNull();
    const current = (quote: string) => ({
      unit_ref: source.ref,
      quote,
      occurrence: 0,
    });
    const prior = (candidate: any) => ({
      unit_ref: candidate.evidence[0].ref,
      quote: candidate.evidence[0].text,
      occurrence: 0,
    });
    const next = {
      schema: "butler.memory-extract-output.v2",
      window_ref: input.window_ref,
      disposition: "processed",
      covered_unit_refs: input.source_units.map((unit: any) => unit.ref),
      nodes: [
        {
          local_ref: "luna",
          type: "entity",
          label: "Luna",
          resolution: {
            kind: "reuse",
            node_ref: luna.ref,
            reason: "explicit_alias",
            evidence: [current("Luna"), prior(luna)],
          },
          aliases: [],
          evidence: [current("Luna")],
        },
        {
          local_ref: "blue-ball",
          type: "entity",
          label: "青いボール",
          resolution: {
            kind: "reuse", node_ref: blue.ref, reason: "named_context",
            evidence: [current("青いボール"), prior(blue)],
          },
          aliases: [], evidence: [current("青いボール")],
        },
        {
          local_ref: "red-ball",
          type: "entity",
          label: "赤いボール",
          resolution: {
            kind: "create",
            provisional: false,
            identity_scope: "user",
          },
          aliases: [],
          evidence: [current("赤いボール")],
        },
      ],
      claims: [
        {
          local_ref: "not-blue", type: "preference",
          resolution: { kind: "create", provisional: false, identity_scope: "user" },
          statement: "Lunaは青いボールが好きではない。",
          subject_ref: "luna", object_ref: "blue-ball", speech_act: "assertion",
          basis: "user_statement", polarity: "negative", condition: null,
          valid_from: source.observed_at, valid_to: null, salience: "normal",
          evidence: [current(source.text)],
        },
        {
          local_ref: "preference",
          type: "preference",
          resolution: {
            kind: "create",
            provisional: false,
            identity_scope: "user",
          },
          statement: source.text,
          subject_ref: "luna",
          object_ref: "red-ball",
          speech_act: "assertion",
          basis: "user_statement",
          polarity: "positive",
          condition: null,
          valid_from: source.observed_at,
          valid_to: null,
          salience: "normal",
          evidence: [current(source.text)],
        },
      ],
      relations: [
        {
          from_ref: "luna", to_ref: "blue-ball", relation: "likes",
          claim_ref: "not-blue", evidence: [current(source.text)],
        },
        {
          from_ref: "luna",
          to_ref: "red-ball",
          relation: "likes",
          claim_ref: "preference",
          evidence: [current(source.text)],
        },
      ],
      corrections: [
        {
          previous_claim_ref: previousClaim.ref, replacement_claim_ref: "not-blue",
          relation: "contradicts", effective_at: source.observed_at,
          evidence: [current(source.text)],
        },
        {
          previous_claim_ref: previousClaim.ref,
          replacement_claim_ref: "preference",
          relation: "supersedes",
          effective_at: source.observed_at,
          evidence: [current(source.text)],
        },
      ],
      summary: { text: source.text, evidence: [current(source.text)] },
    };
    for (const key of Object.keys(output)) delete output[key];
    Object.assign(output, next);
    correctionInput = structuredClone(input);
    correctionOutput = structuredClone(output);
  };
  await Bun.sleep(5);
  const correctionText =
    "訂正するね。Lunaは青いボールが好きではなく、赤いボールが好きです。";
  const source = seedTurn(
    butlerData,
    "correction-later-session",
    "correction-claim",
    correctionText,
    "Noted.",
    1,
  );
  const registered = await memory.ingestConversationMemory({ context, source });
  expect(registered.source.state).toBe("complete");
  const progress = await advanceUntilSemanticTerminal(
    memory,
    context,
    registered.job_id,
  );
  expect(progress?.semantic_graph.state).toBe("complete");
  const cacheBeforeCorrectionRefresh = readFileSync(join(
    butlerData, "cognition", "memory", "generations", descriptor.generation_id, "hot", "cache.md",
  ), "utf8");
  expect(cacheBeforeCorrectionRefresh).toContain("Luna likes the blue ball.");
  expect(assembledMemoryPrompt(butlerData, "correction-later-session", "project-a")).not.toContain("Luna likes the blue ball.");
  await advanceUntilHotCacheComplete(memory, context, registered.job_id);
  const correctedPrompt = assembledMemoryPrompt(butlerData, "correction-later-session", "project-a");
  expect(correctedPrompt).toContain(correctionText);
  expect(correctedPrompt).not.toContain("Luna likes the blue ball.");
  let priorObservedAt: string;
  let correctionObservedAt: string;
  const graph = new Database(
    join(
      butlerData,
      "cognition",
      "memory",
      "generations",
      descriptor.generation_id,
      "graph.sqlite",
    ),
    { readonly: true },
  );
  try {
    expect(graph.query<{ n: number }, []>("SELECT count(*) n FROM edges e JOIN entities c ON c.id=e.claim_node_id WHERE e.rel_type='likes' AND json_extract(c.properties,'$.polarity')='negative'").get()!.n).toBe(1);
    expect(graph.query<{ n: number }, []>("SELECT count(*) n FROM edges WHERE rel_type='contradicts'").get()!.n).toBe(1);
    const persisted = graph.query<{ input_json: string; output_json: string; provider_evidence_json: string }, [string]>("SELECT input_json,output_json,provider_evidence_json FROM memory_projection_windows WHERE job_id=? AND state='complete'").get(registered.job_id)!;
    const persistedInput = JSON.parse(persisted.input_json);
    const incompatible = JSON.parse(persisted.output_json);
    incompatible.relations.find((relation: any) => relation.claim_ref === "not-blue").relation = "dislikes";
    expect(() => normalizeAndValidatePlan(graph, persistedInput, incompatible)).toThrow("memory_extract_invalid_correction");
    const wrongEvidence = JSON.parse(persisted.output_json);
    const reusedLuna = wrongEvidence.nodes.find((node: any) => node.local_ref === "luna");
    const otherCandidate = persistedInput.candidates.find((candidate: any) => candidate.type === "preference");
    // Model the observed bounded candidate list: this quote remains supplied by another candidate only.
    const restrictedInput = structuredClone(persistedInput);
    const selectedCandidate = restrictedInput.candidates.find((candidate: any) => candidate.ref === reusedLuna.resolution.node_ref);
    selectedCandidate.evidence = selectedCandidate.evidence.filter((unit: any) => unit.ref !== otherCandidate.evidence[0].ref);
    expect(selectedCandidate.evidence.length).toBeGreaterThan(0);
    reusedLuna.resolution.evidence[1] = { unit_ref: otherCandidate.evidence[0].ref, quote: otherCandidate.evidence[0].text, occurrence: 0 };
    expect(() => normalizeAndValidatePlan(graph, restrictedInput, wrongEvidence)).toThrow("memory_extract_invalid_identity_reuse");
    const wire = JSON.parse(persisted.provider_evidence_json).request_wire;
    const actualRequest = extractionRequests.at(-1)!;
    expect(wire.instructions_sha256).toBe(createHash("sha256").update(actualRequest.instructions).digest("hex"));
    expect(wire.output_schema_sha256).toBe(createHash("sha256").update(JSON.stringify(actualRequest.responseFormat.schema)).digest("hex"));
    expect(
      graph
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) count FROM edges WHERE rel_type='supersedes'")
        .get()!.count,
    ).toBe(1);
    priorObservedAt = graph
      .query<
        { observed_at: string },
        [string]
      >("SELECT observed_at FROM memory_chunk_sources WHERE episode_id=? ORDER BY observed_at DESC LIMIT 1")
      .get(priorJob.episode_id)!.observed_at;
    correctionObservedAt = graph
      .query<
        { observed_at: string },
        [string]
      >("SELECT observed_at FROM memory_chunk_sources WHERE episode_id=? ORDER BY observed_at DESC LIMIT 1")
      .get(registered.episode_id)!.observed_at;
  } finally {
    graph.close();
  }
  expect(Date.parse(correctionObservedAt)).toBeGreaterThan(
    Date.parse(priorObservedAt),
  );
  const recallAt = (asOf: string, turnId: string) =>
    memory.recallMemory({
      context,
      cue: "Luna",
      includeVector: false,
      includeInternal: false,
      limit: 6,
      scope: "current_project" as const,
      projectFilter: "any" as const,
      projectIds: [],
      sessionIds: [],
      asOf,
      runtime: {
        sessionId: "correction-session",
        turnId,
        currentUserMessage: "Luna",
        nativeOperationId: `${turnId}-operation`,
        projectId: "project-a",
      },
    });
  const priorObservedMs = Date.parse(priorObservedAt);
  const correctionObservedMs = Date.parse(correctionObservedAt);
  const current = await recallAt(
    new Date(correctionObservedMs + 10).toISOString(),
    "correction-current",
  );
  const past = await recallAt(
    new Date(
      Math.floor((priorObservedMs + correctionObservedMs) / 2),
    ).toISOString(),
    "correction-past",
  );
  const futureObserved = await recallAt(
    new Date(priorObservedMs - 10).toISOString(),
    "correction-future-observed",
  );
  expect(
    current.results.some((result) => result.evidence.some((evidence) => evidence.excerpt === correctionText)),
  ).toBe(true);
  expect(
    current.results.some(
      (result) => result.summary === "Luna likes the blue ball.",
    ),
  ).toBe(false);
  expect(
    past.results.some(
      (result) => result.summary === "Luna likes the blue ball.",
    ),
  ).toBe(true);
  expect(past.results.some((result) => result.evidence.some((evidence) => evidence.excerpt === correctionText))).toBe(
    false,
  );
  expect(
    futureObserved.results.some((result) => result.evidence.some((evidence) => evidence.excerpt === correctionText)),
  ).toBe(false);
  expect(correctionInput).not.toBeNull();
  expect(correctionOutput).not.toBeNull();
  const outputPrevious = structuredClone(correctionOutput!);
  outputPrevious.corrections[0].previous_claim_ref = "preference";
  expect(() =>
    normalizeAndValidatePlan(
      null as never,
      correctionInput as never,
      outputPrevious as never,
    ),
  ).toThrow("memory_extract_invalid_ref");

  const entityPrevious = structuredClone(correctionOutput!);
  entityPrevious.corrections[0].previous_claim_ref =
    correctionInput!.candidates.find(
      (candidate: any) => candidate.type === "entity",
    )!.ref;
  expect(() =>
    normalizeAndValidatePlan(
      null as never,
      correctionInput as never,
      entityPrevious as never,
    ),
  ).toThrow("memory_extract_invalid_ref");

  const nodeReplacement = structuredClone(correctionOutput!);
  nodeReplacement.corrections[0].replacement_claim_ref =
    nodeReplacement.nodes[0].local_ref;
  expect(() =>
    normalizeAndValidatePlan(
      null as never,
      correctionInput as never,
      nodeReplacement as never,
    ),
  ).toThrow("memory_extract_invalid_ref");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("two successful semantic windows automatically republish the combined current summary", async () => {
  const butlerData = mkdtempSync(
    join(tmpdir(), "butler-memory-multi-summary-"),
  );
  roots.push(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const embeddingServer = await startCheckedEmbeddingServer(process.env.EMBED_SOCKET!);
  const memory =
    await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  const store = new AgentConversationStore({ butlerData });
  store.beginTurn({
    gateway: "app",
    externalSessionId: "summary-session",
    sessionId: "summary-session",
    actor: "user",
    turnId: "summary-turn",
    projectId: "project-a",
  });
  const message = store.appendUserMessage({
    sessionId: "summary-session",
    turnId: "summary-turn",
    text: "unused",
    originKind: "user_input",
    originRef: "test",
    parts: [
      {
        kind: "text",
        contentJson: { text: `first-window ${"a".repeat(4_900)}` },
      },
      {
        kind: "text",
        contentJson: { text: `second-window ${"b".repeat(4_900)}` },
      },
    ],
  });
  store.finalizeTurn({
    turnId: "summary-turn",
    status: "complete",
    outcomeCapsule: {
      sessionId: "summary-session",
      turnId: "summary-turn",
      generation: 1,
      outcome: "delivered",
      requestMessageId: message.id,
    },
  });
  store.close();
  const context = {
    butlerData,
    target: {
      kind: "active" as const,
      expected_generation: descriptor.generation_id,
    },
    signal: new AbortController().signal,
  };
  transformExtractionOutput = (output, input) => {
    const source = input.source_units[0];
    const summary = source.text.slice(0, 12);
    const next = {
      schema: "butler.memory-extract-output.v2",
      window_ref: input.window_ref,
      disposition: "processed",
      covered_unit_refs: input.source_units.map((unit: any) => unit.ref),
      nodes: [],
      claims: [],
      relations: [],
      corrections: [],
      summary: {
        text: summary,
        evidence: [{ unit_ref: source.ref, quote: summary, occurrence: 0 }],
      },
    };
    for (const key of Object.keys(output)) delete output[key];
    Object.assign(output, next);
  };
  const registered = await memory.ingestConversationMemory({
    context,
    source: {
      kind: "conversation_turn",
      session_id: "summary-session",
      turn_id: "summary-turn",
      outcome_generation: 1,
    },
  });
  const graphPath = join(
    butlerData,
    "cognition",
    "memory",
    "generations",
    descriptor.generation_id,
    "graph.sqlite",
  );
  const initial = new Database(graphPath, { readonly: true });
  expect(
    initial
      .query<
        { n: number },
        [string]
      >("SELECT COUNT(*) n FROM memory_projection_windows WHERE job_id=? AND state!='replaced'")
      .get(registered.job_id)!.n,
  ).toBe(2);
  initial.close();

  const completed = await advanceUntilSemanticAndHotCacheComplete(memory, context, registered.job_id);
  const admissionDb = new Database(join(butlerData, "cognition/memory/generations", descriptor.generation_id, "graph.sqlite"), { readonly: true });
  try {
    expect(admissionDb.query<{ n: number }, [string]>(
      "SELECT COUNT(*) n FROM memory_hot_cache_outcomes WHERE generation=?",
    ).get(descriptor.generation_id)!.n).toBeGreaterThan(0);
  } finally { admissionDb.close(); }

  expect(completed.semantic_graph.state).toBe("complete");
  expect(completed.hot_cache.state).toBe("complete");
  const cache = readFileSync(
    join(
      butlerData,
      "cognition",
      "memory",
      "generations",
      descriptor.generation_id,
      "hot",
      "cache.md",
    ),
    "utf8",
  );
  expect(cache).toContain("first-window");
  expect(cache).toContain("second-windo");
  const cachePath = join(
    butlerData,
    "cognition",
    "memory",
    "generations",
    descriptor.generation_id,
    "hot",
    "cache.md",
  );
  writeFileSync(cachePath, `${cache}\nSOURCE_FREE_LEGACY_AUDIT\n`, "utf8");
  const prompt = (projectId: string) => new PromptAssembler({
    butlerHome: join(butlerData, "home"),
    butlerData,
  }).buildTurnContext({
    binding: {
      sessionId: "summary-session", role: "butler", projectId,
      workspacePath: join(butlerData, "workspace"), runtimeAdapterId: "codex-api",
      modelProviderId: "test", modelRef: "test/model", transportBindings: [],
      metadata: {}, lifecycleState: "active", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    },
    envelope: {
      eventId: "test:t5b", transport: "mock", accountId: "default",
      peer: { kind: "dm", id: "peer" }, sender: { id: "user" },
      message: { id: "message", text: "continue", timestamp: new Date(0).toISOString() },
    },
  });
  expect(prompt("project-a")).toContain("first-window");
  expect(prompt("project-a")).toContain("second-windo");
  expect(prompt("project-a")).not.toContain("SOURCE_FREE_LEGACY_AUDIT");
  expect(prompt("project-b")).not.toContain("first-window");
  const canonical = new Database(join(butlerData, "runtime", "conversation-store.sqlite"));
  canonical.query("UPDATE conversation_parts SET content_json=? WHERE message_id=?")
    .run(JSON.stringify({ text: `corrected-window ${"c".repeat(4_900)}` }), message.id);
  canonical.close();
  expect(prompt("project-a")).not.toContain("first-window");
  const revisedStore = new AgentConversationStore({ butlerData });
  revisedStore.finalizeTurn({
    turnId: "summary-turn", status: "complete",
    outcomeCapsule: {
      sessionId: "summary-session", turnId: "summary-turn", generation: 2,
      outcome: "delivered", requestMessageId: message.id,
    },
  });
  revisedStore.close();
  const corrected = await memory.ingestConversationMemory({
    context,
    source: { kind: "conversation_turn", session_id: "summary-session", turn_id: "summary-turn", outcome_generation: 2 },
  });
  const correctedCompleted = await advanceUntilSemanticAndHotCacheComplete(memory, context, corrected.job_id);
  expect(correctedCompleted.semantic_graph.state).toBe("complete");
  expect(correctedCompleted.hot_cache.state).toBe("complete");
  expect(prompt("project-a")).toContain("corrected-wi");
  expect(prompt("project-a")).not.toContain("first-window");
  await new Promise<void>((resolve) => embeddingServer.close(() => resolve()));
});

test("rebuild readiness preserves nested split-parent evidence while registration stays leaf-based", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-memory-rebuild-source-spans-"));
  roots.push(butlerData);
  initializeEmptyMemoryGeneration(butlerData);
  const text = "REBUILD_UNICODE_SPAN 고양이🐈 ".repeat(350).trim();
  const textBytes = Buffer.byteLength(text, "utf8");
  const source = seedTurn(
    butlerData, "rebuild-span-session", "rebuild-span-turn", text, "Noted.", 1,
    {
      user: "user_input", assistant: "assistant_public",
      publicAdmission: { eventId: "rebuild-span-public-source" },
    },
  );
  expect(textBytes).toBeGreaterThan(8 * 1024);
  expect(textBytes).toBeLessThan(32 * 1024);

  const { runMemoryRebuildCommand } = await import(
    "../../packages/butler-agent/src/agent/cognition/memory/scripts/consolidation-cycle.ts"
  );
  const prepared = await runMemoryRebuildCommand({
    butlerData, argv: ["--memory-rebuild", "prepare"], signal: new AbortController().signal,
  });
  const generationId = String(prepared.generationId);
  const canonicalSnapshotId = String(prepared.canonicalSnapshotId);
  const memory = await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  const registered = await memory.ingestConversationMemory({
    context: {
      butlerData,
      target: { kind: "rebuild", generation_id: generationId, canonical_snapshot_id: canonicalSnapshotId },
      signal: new AbortController().signal,
    },
    source,
  });
  expect(registered.source.state).toBe("complete");

  const generationRoot = join(butlerData, "cognition", "memory", "generations", generationId);
  const graph = new Database(join(generationRoot, "graph.sqlite"), { readonly: true });
  let episodeId = "";
  let registeredSourceIds: string[] = [];
  let registeredUserSourceCount = 0;
  try {
    episodeId = graph.query<{ episode_id: string }, [string]>(
      "SELECT episode_id FROM memory_projection_jobs WHERE job_id=?",
    ).get(registered.job_id)!.episode_id;
    registeredSourceIds = graph.query<{ source_id: string }, [string]>(
      "SELECT source_id FROM memory_chunk_sources WHERE episode_id=? ORDER BY source_id",
    ).all(episodeId).map((row) => row.source_id);
    registeredUserSourceCount = graph.query<{ count: number }, [string]>(
      "SELECT COUNT(*) count FROM memory_chunk_sources WHERE episode_id=? AND role='user'",
    ).get(episodeId)!.count;
  } finally {
    graph.close();
  }
  const inventory = JSON.parse(readFileSync(
    join(generationRoot, "source-snapshot", "memory-source-inventory.json"), "utf8",
  )) as { schema: string; origin?: { version?: string | null }; exclusions?: unknown;
    entries: Array<{ episodeId: string; sourceUnitCount: number; sourceIds: string[] }>;
    typed?: unknown[]; typed_lifecycle?: unknown[]; history?: unknown[] };
  const entry = inventory.entries.find((item) => item.episodeId === episodeId);
  expect(registeredUserSourceCount).toBeGreaterThan(1);
  expect(entry).toBeTruthy();
  expect(entry!.sourceUnitCount).toBe(registeredSourceIds.length);
  expect(entry!.sourceIds).toEqual(registeredSourceIds);
  const mutable = new Database(join(generationRoot, "graph.sqlite"));
  const split = (sourceId: string, prefix: string): string[] => {
    const row = mutable.query<any, [string]>("SELECT * FROM memory_chunk_sources WHERE source_id=?").get(sourceId)!;
    const text = hydrateSource(join(generationRoot, "source-snapshot"), row).text;
    const graphemes = [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text)].map((item) => item.segment);
    const midpoint = row.byte_start + Buffer.byteLength(graphemes.slice(0, Math.floor(graphemes.length / 2)).join(""));
    const ids = [`${prefix}-left`, `${prefix}-right`];
    mutable.query(`INSERT INTO memory_source_split_parents
      (source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,
       byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis,child_source_ids_json,recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.source_id,row.episode_id,row.revision,row.source_kind,row.conversation_session_id,row.conversation_message_id,
      row.part_id,row.scalar_pointer,row.byte_start,row.byte_end,row.content_hash,row.role,row.origin_kind,row.observed_at,
      row.basis,JSON.stringify(ids),new Date().toISOString(),
    );
    for (const [index, id] of ids.entries()) mutable.query(`INSERT INTO memory_chunk_sources
      (source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,
       byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id,row.episode_id,row.revision,row.source_kind,row.conversation_session_id,row.conversation_message_id,row.part_id,
      row.scalar_pointer,index === 0 ? row.byte_start : midpoint,index === 0 ? midpoint : row.byte_end,row.content_hash,
      row.role,row.origin_kind,row.observed_at,row.basis,
    );
    return ids;
  };
  const rootSource = mutable.query<{ source_id: string }, [string]>(`SELECT source_id FROM memory_chunk_sources
    WHERE episode_id=? AND role='user' ORDER BY byte_end-byte_start DESC LIMIT 1`).get(episodeId)!.source_id;
  const [intermediate] = split(rootSource, "readiness-parent");
  split(intermediate!, "readiness-leaf");
  const job = mutable.query<{ job_id: string; revision: string; project_id: string | null; origin_kind: string }, [string, string]>(`SELECT j.job_id,j.revision,c.project_id,s.origin_kind
    FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id
    JOIN memory_chunk_sources s ON s.episode_id=j.episode_id AND s.revision=j.revision
    WHERE j.job_id=? AND s.source_id=?`).get(registered.job_id, intermediate!)!;
  mutable.query(`INSERT INTO memory_vector_units(unit_id,job_id,record_kind,owner_id,owner_revision,project_id,origin_kind,
    projection_text,state,receipt_json,source_ids_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    "readiness-parent-vector",job.job_id,"episode","episode-owner",job.revision,job.project_id,job.origin_kind,
    "historical parent evidence","complete",JSON.stringify({ generation: generationId }),JSON.stringify([intermediate]),
  );
  mutable.close();
  const readinessArgs = { butlerData,generationId,inventoryHash: memorySourceInventoryHash(inventory),
    inventorySourceCount: inventory.entries.reduce((count, item) => count + item.sourceIds.length, 0) };
  const valid = await computeMemoryGenerationReadiness(readinessArgs);
  const invalidDb = new Database(join(generationRoot, "graph.sqlite"));
  invalidDb.query("UPDATE memory_vector_units SET source_ids_json=? WHERE unit_id='readiness-parent-vector'")
    .run(JSON.stringify(["unknown-source-evidence"]));
  invalidDb.close();
  const invalid = await computeMemoryGenerationReadiness(readinessArgs);
  expect(invalid.unaccounted).toBe(valid.unaccounted + 1);
  expect(invalid.ready).toBe(false);
});

test("conversation inventory excludes recoverable running turns until canonical terminal transition", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-memory-terminal-inventory-"));
  roots.push(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const eventId = "terminal-inventory-public-source";
  const store = new AgentConversationStore({ butlerData });
  const turn = store.beginTurn({
    gateway: "app", externalSessionId: "terminal-inventory-session",
    sessionId: "terminal-inventory-session", projectId: "project-a", actor: "user",
    turnId: "terminal-inventory-turn", requestId: eventId,
  });
  new NativeInboundQueue(butlerData).enqueue({
    eventId, transport: "app", accountId: "default",
    peer: { kind: "dm", id: turn.session_id }, sender: { id: "user" },
    message: { id: eventId, text: "Preserve this running public request.", timestamp: new Date(0).toISOString() },
    routingHints: { sessionId: turn.session_id, turnId: turn.id },
  });
  const request = store.appendUserMessage({
    sessionId: turn.session_id, turnId: turn.id,
    text: "Preserve this running public request.", originKind: "user_input",
    originRef: eventId, sourceGateway: "app", sourceRef: eventId,
  });
  store.writeTurnOutcome({
    sessionId: turn.session_id, turnId: turn.id, generation: 1,
    outcome: "recoverable", requestMessageId: request.id, publicAssistantMessageId: null,
    safeCode: "runtime_recoverable",
  });
  store.close();

  const { canonicalConversationProjectionInventory } = await import(
    "../../packages/butler-agent/src/agent/cognition/memory/projection/source.ts"
  );
  const readInventory = () => canonicalConversationProjectionInventory({
    butlerData, asOf: new Date().toISOString(), deadlineAt: Date.now() + 5_000,
    scope: "all_user_sessions" as const, currentSessionId: "", currentProjectId: null,
    sessionIds: [], projectFilter: "any" as const, projectIds: [],
  });
  const runningInventory = readInventory();
  expect(runningInventory.entries).toHaveLength(0);
  expect(runningInventory.exclusions.turn_not_terminal).toBe(1);

  const memory = await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  const context = {
    butlerData,
    target: { kind: "active" as const, expected_generation: descriptor.generation_id },
    signal: new AbortController().signal,
  };
  const source = {
    kind: "conversation_turn" as const, session_id: turn.session_id,
    turn_id: turn.id, outcome_generation: 1,
  };
  await expect(memory.ingestConversationMemory({ context, source })).rejects.toThrow("memory_source_not_terminal");

  const terminalStore = new AgentConversationStore({ butlerData });
  terminalStore.finalizeTurn({ turnId: turn.id, status: "complete" });
  terminalStore.close();
  const terminalInventory = readInventory();
  expect(terminalInventory.entries).toHaveLength(1);
  expect(terminalInventory.exclusions.turn_not_terminal).toBeUndefined();
  expect((await memory.ingestConversationMemory({ context, source })).source.state).toBe("complete");
});

test("rebuild target writes its validated cache without exposing it through the active prompt", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-memory-rebuild-cache-"));
  roots.push(butlerData);
  const active = initializeEmptyMemoryGeneration(butlerData);
  const source = seedTurn(
    butlerData, "rebuild-cache-session", "rebuild-cache-turn",
    "REBUILD_CACHE_ONLY_SENTINEL", "Noted.", 1,
    {
      user: "user_input", assistant: "assistant_public",
      publicAdmission: { eventId: "rebuild-cache-public-source" },
    },
  );
  const secondSource = seedTurn(
    butlerData, "rebuild-cache-session-two", "rebuild-cache-turn-two",
    "REBUILD_CACHE_SECOND_SENTINEL", "Noted twice.", 1,
    {
      user: "user_input", assistant: "assistant_public",
      publicAdmission: { eventId: "rebuild-cache-public-source-two" },
    },
  );
  const initialCanonical = new Database(join(butlerData, "runtime", "conversation-store.sqlite"), { readonly: true });
  const sourceMessageId = initialCanonical.query<{ id: string }, [string]>(
    "SELECT id FROM conversation_messages WHERE turn_id=? AND role='user' LIMIT 1",
  ).get(source.turn_id)?.id;
  initialCanonical.close();
  expect(sourceMessageId).toBeTruthy();
  const { createMemoryToolHandlers } = await import(
    "../../packages/butler-agent/src/agent/tools/memory/index.ts"
  );
  const rule = await createMemoryToolHandlers({ butlerHome: butlerData, butlerData, projectId: "project-a" })
    .update_explicit_memory({
      name: "update_explicit_memory",
      args: { kind: "rule", text: "Snapshot rule v1.", source: "app:rebuild-fixture" },
      rawArguments: JSON.stringify({ kind: "rule", text: "Snapshot rule v1.", source: "app:rebuild-fixture" }),
    }, { effectOccurrenceId: "rebuild-rule-v1" }) as any;
  const { PlannedTaskStore } = await import("../../packages/butler-agent/src/agent/work/planned-task.ts");
  const taskStore = new PlannedTaskStore(butlerData);
  taskStore.create({
    task_id: "snapshot-task", type: "planned", goal: "preserve strict snapshot task",
    project: "project-a", created_at: "2026-09-10T00:00:00.000Z",
    origin_session_id: "rebuild-cache-session", origin_event_id: "rebuild-task-event",
    decision_policy: "autonomous", acceptance_criteria: ["snapshot verified"],
    verification_commands: ["bun test"], review_policy: "review every criterion",
    repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    public_report_policy: "report after review",
  });
  taskStore.transition("snapshot-task", "PLANNED_RUNNING");
  taskStore.writeAttemptResult("snapshot-task", 1, "Snapshot task result v1.");
  taskStore.transition("snapshot-task", "WORKER_DONE");
  taskStore.transition("snapshot-task", "REVIEWING");
  taskStore.writeReview({
    task_id: "snapshot-task", attempt: 1, verdict: "PASS", reviewed_at: "2026-09-10T00:01:00.000Z",
    goal_review: { goal: "preserve strict snapshot task", verdict: "PASS", evidence: "snapshot verified" },
    criteria: [{ criterion: "snapshot verified", verdict: "PASS", evidence: "fixture owner" }],
    missing_evidence: [], repair_recommendation: null,
  });
  taskStore.transition("snapshot-task", "REVIEW_PASSED");
  taskStore.transition("snapshot-task", "PUBLIC_REPORT_READY");
  taskStore.writePublicReport("snapshot-task", "Snapshot task result v1.");
  const { TaskStore } = await import("../../packages/butler-agent/src/agent/work/task-store.ts");
  const taskReport = new TaskStore(butlerData).readMemoryReport("snapshot-task")!;
  const quality = await import("../../packages/butler-agent/src/agent/cognition/memory/quality.ts");
  quality.ingestTaskOutcomeMemory({ butlerData, taskId: "snapshot-task" });
  const { runMemoryRebuildCommand } = await import(
    "../../packages/butler-agent/src/agent/cognition/memory/scripts/consolidation-cycle.ts"
  );
  const prepared = await runMemoryRebuildCommand({
    butlerData,
    argv: ["--memory-rebuild", "prepare"],
    signal: new AbortController().signal,
  });
  const generationId = String(prepared.generationId);
  const canonicalSnapshotId = String(prepared.canonicalSnapshotId);
  expect(generationId).toBeTruthy();
  expect(canonicalSnapshotId).toMatch(/^[a-f0-9]{64}$/u);
  const descriptorPath = join(butlerData, "cognition", "memory", "active-generation.json");
  const descriptorBytes = readFileSync(descriptorPath, "utf8");
  const cli = join(process.cwd(), "packages", "butler-agent", "src", "agent", "cognition", "memory", "scripts", "consolidation-cycle.ts");
  const invalidAcceptancePath = join(butlerData, "invalid-acceptance.json");
  writeFileSync(invalidAcceptancePath, JSON.stringify({ schema: "not-accepted" }), "utf8");
  const stagedDestinationRoot = join(butlerData, "cognition", "memory", "generations", generationId);
  const snapshotRoot = join(stagedDestinationRoot, "source-snapshot");
  const snapshotRecords = quality.listTypedMemoryRecordsSnapshot(snapshotRoot);
  expect(snapshotRecords.some(({ record }) => record.source_kind === "explicit_record" && record.record_id === rule.record_id)).toBe(true);
  expect(snapshotRecords.some(({ record }) => record.source_kind === "task_report" && record.record_id === taskReport.record_id)).toBe(true);
  expect(quality.readTypedMemoryRecord(snapshotRoot, "explicit_record", rule.record_id)?.text).toBe("Snapshot rule v1.");
  const context = {
    butlerData,
    target: { kind: "rebuild" as const, generation_id: generationId, canonical_snapshot_id: canonicalSnapshotId },
    signal: new AbortController().signal,
  };
  transformExtractionOutput = (output, input) => {
    if (!Array.isArray(input.parts)) return;
    const part = input.parts[0];
    for (const key of Object.keys(output)) delete output[key];
    Object.assign(output, {
      status: "processed", entities: [],
      items: [{ kind: "fact", subject: null, text: part.text, evidence: [part.id] }],
      attributes: [],
    });
  };
  const memory = await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  let holdEmbedding = false;
  const embeddingControl: { notify: (() => void) | null; release: (() => void) | null } = {
    notify: null, release: null,
  };
  const embeddingStarted = new Promise<void>((resolve) => { embeddingControl.notify = resolve; });
  const embeddingReleased = new Promise<void>((resolve) => { embeddingControl.release = resolve; });
  const embeddingServer = await startCheckedEmbeddingServer(process.env.EMBED_SOCKET!, async () => {
    if (!holdEmbedding) return;
    embeddingControl.notify?.();
    await embeddingReleased;
  });
  const activeContext = {
    butlerData,
    target: { kind: "active" as const, expected_generation: active.generation_id },
    signal: new AbortController().signal,
  };
  const activeRegistered = await memory.ingestConversationMemory({ context: activeContext, source });
  await advanceUntilSemanticAndHotCacheComplete(memory, activeContext, activeRegistered.job_id);
  const activeSecondRegistered = await memory.ingestConversationMemory({ context: activeContext, source: secondSource });
  await advanceUntilSemanticAndHotCacheComplete(memory, activeContext, activeSecondRegistered.job_id);
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const activeGraph = new Database(join(
      butlerData, "cognition", "memory", "generations", active.generation_id, "graph.sqlite",
    ), { readonly: true });
    const pending = activeGraph.query<{ n: number }, [string]>(`SELECT COUNT(*) n FROM memory_vector_units u
      JOIN memory_projection_jobs j ON j.job_id=u.job_id WHERE j.generation=? AND u.state!='complete'`)
      .get(active.generation_id)?.n ?? 0;
    activeGraph.close();
    if (pending === 0) break;
    await memory.advanceNextMemoryProjection({ context: activeContext });
  }
  const readyActiveGraph = new Database(join(
    butlerData, "cognition", "memory", "generations", active.generation_id, "graph.sqlite",
  ), { readonly: true });
  expect(readyActiveGraph.query<{ n: number }, [string]>(`SELECT COUNT(*) n FROM memory_vector_units u
    JOIN memory_projection_jobs j ON j.job_id=u.job_id WHERE j.generation=? AND u.state!='complete'`)
    .get(active.generation_id)?.n ?? 0).toBe(0);
  readyActiveGraph.close();
  const registered = await memory.ingestConversationMemory({ context, source });
  const secondRegistered = await memory.ingestConversationMemory({ context, source: secondSource });
  const typedJobs: Array<{ job_id: string }> = [];
  for (const { record } of snapshotRecords) {
    typedJobs.push(await memory.ingestConversationMemory({
      context,
      source: record.source_kind === "task_report"
        ? { kind: "task_report" as const, record_id: record.record_id, revision: record.revision, operation_id: record.operation_id }
        : { kind: "explicit_record" as const, record_kind: record.record_kind as "rule" | "feedback",
          record_id: record.record_id, revision: record.revision, operation_id: record.operation_id },
    }));
  }
  expect(registered.source.state).toBe("complete");
  expect(registered.semantic_graph.state).toBe("pending");
  const progress = await advanceUntilSemanticAndHotCacheComplete(memory, context, registered.job_id);
  const secondProgress = await advanceUntilSemanticAndHotCacheComplete(memory, context, secondRegistered.job_id);
  for (const job of typedJobs) await advanceUntilSemanticAndHotCacheComplete(memory, context, job.job_id);
  expect(progress.hot_cache.state).toBe("complete");
  expect(secondProgress.hot_cache.state).toBe("complete");
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const graph = new Database(join(stagedDestinationRoot, "graph.sqlite"), { readonly: true });
    const pending = graph.query<{ n: number }, [string]>(`SELECT COUNT(*) n FROM memory_vector_units u
      JOIN memory_projection_jobs j ON j.job_id=u.job_id WHERE j.generation=? AND u.state!='complete'`).get(generationId)?.n ?? 0;
    graph.close();
    if (pending === 0) break;
    await memory.advanceNextMemoryProjection({ context });
  }
  const mismatchedAcceptance = Bun.spawnSync([
    process.execPath, "run", cli, "--memory-rebuild", "validate", "--generation", generationId,
    "--acceptance", invalidAcceptancePath,
  ], { cwd: process.cwd(), env: { ...process.env, BUTLER_DATA: butlerData } });
  expect(mismatchedAcceptance.exitCode).toBe(1);
  expect(mismatchedAcceptance.stderr.toString()).toContain("memory_acceptance_invalid");
  expect(readFileSync(descriptorPath, "utf8")).toBe(descriptorBytes);
  quality.updateExplicitMemory({
    butlerData, recordId: rule.record_id, operationId: "rebuild-rule-v2",
    update: { kind: "rule", text: "Snapshot rule v2.", source: "app:rebuild-fixture" },
  });
  expect(quality.readTypedMemoryRecord(snapshotRoot, "explicit_record", rule.record_id)?.text).toBe("Snapshot rule v1.");
  expect(quality.readTypedMemoryRecord(butlerData, "explicit_record", rule.record_id)?.text).toBe("Snapshot rule v2.");
  const delta = seedTurn(
    butlerData, "rebuild-cache-session", "rebuild-cache-delta",
    "LIVE_DELTA_AFTER_PREPARE", "Noted later.", 1,
    {
      user: "user_input", assistant: "assistant_public",
      publicAdmission: { eventId: "rebuild-cache-public-delta" },
    },
  );
  expect(delta.turn_id).not.toBe(source.turn_id);
  const liveCanonical = new Database(join(butlerData, "runtime", "conversation-store.sqlite"), { readonly: true });
  const deltaMessageId = liveCanonical.query<{ id: string }, [string]>(
    "SELECT id FROM conversation_messages WHERE turn_id=? AND role='user' LIMIT 1",
  ).get(delta.turn_id)?.id;
  liveCanonical.close();
  expect(deltaMessageId).toBeTruthy();
  const graph = new Database(join(stagedDestinationRoot, "graph.sqlite"), { readonly: true });
  expect(graph.query<{ n: number }, [string]>(`SELECT COUNT(*) n FROM memory_vector_units u
    JOIN memory_projection_jobs j ON j.job_id=u.job_id WHERE j.generation=? AND u.state='complete'`).get(generationId)?.n).toBeGreaterThan(0);
  expect(graph.query<{ n: number }, [string]>(`SELECT COUNT(*) n FROM memory_chunk_sources
    WHERE conversation_message_id=?`).get(deltaMessageId!)?.n ?? 0).toBe(0);
  const sourceRow = graph.query<{
    source_id: string; episode_id: string; revision: string; content_hash: string;
  }, [string]>(`SELECT source_id,episode_id,revision,content_hash FROM memory_chunk_sources
    WHERE conversation_message_id=? ORDER BY source_id LIMIT 1`).get(sourceMessageId!)!;
  graph.close();
  const activeGraph = new Database(join(
    butlerData, "cognition", "memory", "generations", active.generation_id, "graph.sqlite",
  ), { readonly: true });
  const activeSourceRow = activeGraph.query<{
    source_id: string; episode_id: string; revision: string; content_hash: string;
  }, [string]>("SELECT source_id,episode_id,revision,content_hash FROM memory_chunk_sources WHERE source_id=?")
    .get(sourceRow.source_id)!;
  activeGraph.close();
  expect(activeSourceRow).toEqual(sourceRow);
  const feedback = await import("../../packages/butler-agent/src/agent/cognition/feedback/buffer.ts");
  const feedbackEntry = feedback.addFeedbackEntry(butlerData, {
    text: "Exclude the rebuild source.", targetRef: sourceRow.source_id, scope: "source",
  });
  const operation = feedback.recordFeedbackQualityExclusion(butlerData, {
    feedback_id: feedbackEntry.feedback_id, operation_id: "rebuild-cross-generation-exclusion",
    intent: "exclude", actor: "operator", source_ref: sourceRow.source_id,
    source_revision: sourceRow.revision, source_hash: sourceRow.content_hash,
    generation_id: active.generation_id, episode_id: sourceRow.episode_id, target_revision: sourceRow.revision,
    feedback_owner_revision: feedback.feedbackOwnerRevision(feedbackEntry), scope: "all_user_sessions",
  });
  const generation = await import("../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts");
  const manifestPath = join(stagedDestinationRoot, "manifest.json");
  const oldDescriptor = generation.readActiveDescriptor(butlerData);
  const nextDescriptor = {
    schema: "butler.memory-active-generation.v2" as const,
    generation_id: generationId, previous_generation_id: oldDescriptor.generation_id,
    activated_at: new Date().toISOString(), projection_mode: "running" as const,
  };
  const lockPath = consolidationLockPath(butlerData);
  const forwardLease = acquireConsolidationLock(lockPath, { purpose: "cutover" })!;
  generation.commitMemoryDescriptorTransition({
    butlerData, expectedDescriptor: oldDescriptor, targetGenerationId: generationId,
    expectedTargetManifestSha256: createHash("sha256").update(readFileSync(manifestPath)).digest("hex"),
    nextDescriptor,
  }, forwardLease);
  releaseConsolidationLock(lockPath, forwardLease, true);
  expect(await feedback.applyFeedbackQualityOperation(butlerData, {
    feedbackId: feedbackEntry.feedback_id, operationId: operation.operation_id,
    sourceRevision: sourceRow.revision,
  })).toMatchObject({ status: "applied" });
  feedback.resolveFeedbackEntry(butlerData, feedbackEntry.feedback_id, "applied");
  expect(feedback.clearResolvedFeedbackEntries(butlerData).removed).toBe(1);
  const exclusionDb = new Database(join(stagedDestinationRoot, "graph.sqlite"), { readonly: true });
  expect(feedback.excludedMemorySourceIds(butlerData, {
    db: exclusionDb, generationId, sources: [sourceRow as any],
  }).has(sourceRow.source_id)).toBe(true);
  exclusionDb.close();
  const { createRecallMemoryToolHandler } = await import(
    "../../packages/butler-agent/src/agent/tools/memory/recall_memory/executor.ts"
  );
  const recallHandler = createRecallMemoryToolHandler({
    butlerHome: butlerData, butlerData, sessionId: "rebuild-cache-session",
    turnId: "rebuild-recall", currentUserMessage: "rebuild cache", projectId: "project-a",
  });
  holdEmbedding = true;
  const inFlightRecall = recallHandler({
    name: "recall_memory", args: { cue: "REBUILD_CACHE", include_vector: true, limit: 1, scope: "all_user_sessions" },
    rawArguments: JSON.stringify({ cue: "REBUILD_CACHE", include_vector: true, limit: 1, scope: "all_user_sessions" }),
    toolContractVersion: 2,
  }, { effectOccurrenceId: "rebuild-inflight-recall" }) as Promise<any>;
  await embeddingStarted;
  const backwardLease = acquireConsolidationLock(lockPath, { purpose: "cutover" })!;
  generation.commitMemoryDescriptorTransition({
    butlerData, expectedDescriptor: nextDescriptor, targetGenerationId: active.generation_id,
    expectedTargetManifestSha256: createHash("sha256").update(readFileSync(join(
      butlerData, "cognition", "memory", "generations", active.generation_id, "manifest.json",
    ))).digest("hex"),
    nextDescriptor: { ...oldDescriptor, previous_generation_id: generationId },
  }, backwardLease);
  expect(() => generation.commitMemoryDescriptorTransition({
    butlerData, expectedDescriptor: nextDescriptor, targetGenerationId: generationId,
    expectedTargetManifestSha256: createHash("sha256").update(readFileSync(manifestPath)).digest("hex"),
    nextDescriptor,
  }, backwardLease)).toThrow("memory_generation_changed");
  releaseConsolidationLock(lockPath, backwardLease, true);
  embeddingControl.release?.();
  const pinnedRecall = await inFlightRecall;
  expect(["complete", "partial"]).toContain(pinnedRecall.status);
  const pinnedRefs = pinnedRecall.results.flatMap((result: any) => result.evidence)
    .map((evidence: any) => evidence.source_ref).filter(Boolean);
  expect(pinnedRefs.length).toBeGreaterThan(0);
  expect(pinnedRefs.every((ref: string) => Buffer.from(ref.split(":")[2]!, "base64url").toString("utf8") === generationId))
    .toBe(true);
  let cursorCheck: "stale_cursor" | "not_applicable" = "not_applicable";
  if (pinnedRecall.next_cursor) {
    await expect(recallHandler({
      name: "recall_memory", args: { cue: "REBUILD_CACHE", include_vector: true, limit: 1, scope: "all_user_sessions", cursor: pinnedRecall.next_cursor },
      rawArguments: JSON.stringify({ cue: "REBUILD_CACHE", include_vector: true, limit: 1, scope: "all_user_sessions", cursor: pinnedRecall.next_cursor }),
      toolContractVersion: 2,
    }, { effectOccurrenceId: "rebuild-next-after-cutover" })).rejects.toThrow("stale_cursor");
    cursorCheck = "stale_cursor";
  }
  const freshAfterCutover = await recallHandler({
    name: "recall_memory", args: { cue: "REBUILD_CACHE_SECOND_SENTINEL", include_vector: true, limit: 1, scope: "all_user_sessions" },
    rawArguments: JSON.stringify({ cue: "REBUILD_CACHE_SECOND_SENTINEL", include_vector: true, limit: 1, scope: "all_user_sessions" }),
    toolContractVersion: 2,
  }, { effectOccurrenceId: "rebuild-fresh-after-cutover" }) as any;
  const freshRefs = freshAfterCutover.results.flatMap((result: any) => result.evidence)
    .map((evidence: any) => evidence.source_ref).filter(Boolean);
  expect(freshRefs.length).toBeGreaterThan(0);
  expect(freshRefs.every((ref: string) => Buffer.from(ref.split(":")[2]!, "base64url").toString("utf8") === active.generation_id))
    .toBe(true);
  const rollbackDescriptorBytes = readFileSync(descriptorPath, "utf8");
  const missingAcceptance = Bun.spawnSync([
    process.execPath, "run", cli, "--memory-rebuild", "validate", "--generation", generationId,
  ], { cwd: process.cwd(), env: { ...process.env, BUTLER_DATA: butlerData } });
  expect(missingAcceptance.exitCode).toBe(1);
  expect(missingAcceptance.stderr.toString()).toContain("memory_rebuild_invalid_request");
  expect(readFileSync(descriptorPath, "utf8")).toBe(rollbackDescriptorBytes);
  expect(readFileSync(join(stagedDestinationRoot, "hot", "cache.md"), "utf8")).toContain("REBUILD_CACHE_ONLY_SENTINEL");
  expect(assembledMemoryPrompt(butlerData, "rebuild-cache-session", "project-a")).not.toContain("REBUILD_CACHE_ONLY_SENTINEL");
  expect(JSON.parse(readFileSync(join(butlerData, "cognition", "memory", "active-generation.json"), "utf8")).generation_id).toBe(active.generation_id);
  const { resolveMemorySource } = await import(
    "../../packages/butler-agent/src/agent/cognition/memory/projection/ingestion.ts"
  );
  const collectReturnedSourceFacts = (
    nativeResult: any,
    nativeOperationId: string,
    generationContext: MemoryExecutionContext,
    generationRoot: string,
  ) => {
    const evidenceDb = new Database(join(generationRoot, "graph.sqlite"), { readonly: true });
    try {
      return nativeResult.results.flatMap((result: any) => result.evidence.map((evidence: any) => {
        expect(evidence.source_ref).toStartWith("memory-source:v2:");
        const parts = evidence.source_ref.split(":");
        const sourceId = Buffer.from(parts[3]!, "base64url").toString("utf8");
        const row = evidenceDb.query<{
          source_id: string; episode_id: string; revision: string; content_hash: string;
          source_kind: string; conversation_session_id: string | null;
          conversation_message_id: string | null; part_id: string; scalar_pointer: string;
          byte_start: number; byte_end: number; observed_at: string; role: string; origin_kind: string;
          conversation_start: string | null; conversation_end: string | null;
          project_id: string | null; current_revision: string; chunk_status: string;
        }, [string]>(`SELECT s.source_id,s.episode_id,s.revision,s.content_hash,s.source_kind,
          s.conversation_session_id,s.conversation_message_id,s.part_id,s.scalar_pointer,
          s.byte_start,s.byte_end,s.observed_at,s.role,s.origin_kind,
          c.conversation_start,c.conversation_end,c.project_id,c.current_revision,c.status chunk_status
          FROM memory_chunk_sources s JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id
          WHERE s.source_id=?`).get(sourceId);
        expect(row).toBeTruthy();
        const fullSource = resolveMemorySource({ context: generationContext, sourceRef: evidence.source_ref });
        expect(fullSource.source_hash).toBe(row!.content_hash);
        return {
          native_operation_id: nativeOperationId,
          episode_ref: result.episode_ref,
          result_revision: result.revision,
          source_ref: evidence.source_ref,
          read_args: evidence.read_args,
          returned_excerpt: evidence.excerpt,
          source_row: row,
          canonical: {
            message_id: fullSource.conversation_message_id,
            part_id: row!.part_id,
            scalar_pointer: row!.scalar_pointer,
            text: fullSource.scalar_text ?? fullSource.text,
            bytes: Buffer.byteLength(fullSource.scalar_text ?? fullSource.text, "utf8"),
            sha256: fullSource.source_hash,
            revision: row!.revision,
          },
          source_span: {
            text: fullSource.text,
            byte_start: fullSource.byte_start,
            byte_end: fullSource.byte_end,
          },
        };
      }));
    } finally {
      evidenceDb.close();
    }
  };
  const candidateSourceFacts = collectReturnedSourceFacts(
    pinnedRecall, "rebuild-inflight-recall", context, stagedDestinationRoot,
  );
  const currentSourceFacts = collectReturnedSourceFacts(
    freshAfterCutover, "rebuild-fresh-after-cutover", activeContext,
    join(butlerData, "cognition", "memory", "generations", active.generation_id),
  );
  const stageDb = new Database(join(stagedDestinationRoot, "graph.sqlite"), { readonly: true });
  const stageInventory = {
    jobs: stageDb.query(`SELECT job_id,episode_id,revision,generation,source_state,
      semantic_graph_state,node_vectors_state,episode_vectors_state,hot_cache_state
      FROM memory_projection_jobs ORDER BY job_id`).all(),
    windows: stageDb.query(`SELECT window_ref,job_id,state,source_refs_json,attempt_count,error_code
      FROM memory_projection_windows ORDER BY window_ref`).all(),
    vectors: stageDb.query(`SELECT unit_id,job_id,state,source_ids_json,attempt_count,error_code,receipt_json
      FROM memory_vector_units ORDER BY unit_id`).all(),
  };
  stageDb.close();
  const snapshotInventoryPath = join(snapshotRoot, "memory-source-inventory.json");
  const snapshotInventoryBytes = readFileSync(snapshotInventoryPath);
  writeT6OwnerEvidence("t6-b-rebuild-owner-result.json", {
    schema: "butler.memory-owner-result-evidence.v1",
    result_id: "rebuild-inflight-recall",
    generation_id: generationId,
    status: pinnedRecall.status === "complete" ? "ok" : "partial",
    source_handles: pinnedRefs,
    observations: pinnedRefs.map((source_ref: string) => ({ kind: "source_ref", source_ref })),
    raw_facts: {
      canonical_snapshot_id: canonicalSnapshotId,
      source_inventory_hash: generation.readMemoryGenerationManifest(butlerData, generationId).source_inventory_hash,
      source_row: sourceRow,
      active_source_row: activeSourceRow,
      feedback_operation_id: operation.operation_id,
      feedback_status: "applied",
      owner_removed: true,
      descriptor_before: oldDescriptor,
      descriptor_candidate: nextDescriptor,
      descriptor_after: generation.readActiveDescriptor(butlerData),
      native_status: pinnedRecall.status,
      cursor_check: cursorCheck,
      fresh_generation_source_handles: freshRefs,
      fresh_native_status: freshAfterCutover.status,
      vector_complete: true,
      delta_message_id: deltaMessageId,
    },
    generation_manifest: {
      generation_id: generationId,
      sha256: createHash("sha256").update(readFileSync(manifestPath)).digest("hex"),
    },
    implementation_source_files: [
      "packages/butler-agent/src/agent/cognition/memory/projection/generation.ts",
      "packages/butler-agent/src/agent/cognition/memory/scripts/consolidation-cycle.ts",
    ].map((path) => ({
      path,
      sha256: createHash("sha256").update(readFileSync(join(process.cwd(), path))).digest("hex"),
    })),
  });
  writeT6OwnerEvidence("t6-b-rebuild-source-facts.json", {
    generation_id: generationId,
    canonical_snapshot_id: canonicalSnapshotId,
    snapshot_inventory: JSON.parse(snapshotInventoryBytes.toString("utf8")),
    snapshot_inventory_sha256: createHash("sha256").update(snapshotInventoryBytes).digest("hex"),
    candidate_observations: candidateSourceFacts,
    current_observations: currentSourceFacts,
    stage_inventory: stageInventory,
  });
  await new Promise<void>((resolve) => embeddingServer.close(() => resolve()));
});

test("project recall excludes global evidence and reads project evidence unchanged", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-memory-global-read-"));
  roots.push(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const memory =
    await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  const context = {
    butlerData,
    target: {
      kind: "active" as const,
      expected_generation: descriptor.generation_id,
    },
    signal: new AbortController().signal,
  };
  for (const source of [
    seedTurn(
      butlerData,
      "global-session",
      "global-alias",
      "내 고양이 루나의 영어 이름은 Luna야.",
      "Noted.",
      1,
      undefined,
      null,
    ),
    seedTurn(
      butlerData,
      "project-session",
      "project-alias",
      "내 고양이 루나의 영어 이름은 Luna야.",
      "Noted.",
      1,
    ),
    seedTurn(
      butlerData,
      "project-session",
      "project-claim",
      "Luna likes the blue ball.",
      "Noted.",
      1,
    ),
    seedTurn(
      butlerData,
      "global-session",
      "global-claim",
      "Luna likes the blue ball.",
      "Noted.",
      1,
      undefined,
      null,
    ),
  ]) {
    const job = await memory.ingestConversationMemory({ context, source });
    await advanceUntilSemanticTerminal(memory, context, job.job_id);
  }
  const { createRecallMemoryToolHandler } =
    await import("../../packages/butler-agent/src/agent/tools/memory/recall_memory/executor.ts");
  const { createReadConversationSessionToolHandler } =
    await import("../../packages/butler-agent/src/agent/tools/memory/read_conversation_session/executor.ts");
  const toolInput = {
    butlerHome: butlerData,
    butlerData,
    turnId: "project-query",
    sessionId: "project-session",
    projectId: "project-a",
    currentUserMessage: "Luna likes",
  };
  const recalled = (await createRecallMemoryToolHandler(toolInput)(
    {
      name: "recall_memory",
      args: { cue: "Luna likes", include_vector: false },
      rawArguments: JSON.stringify({
        cue: "Luna likes",
        include_vector: false,
      }),
      toolContractVersion: 2,
    },
    { effectOccurrenceId: "t1-project-recall" },
  )) as any;
  const readArgs = recalled.results
    .flatMap((result: any) => result.evidence)
    .find((evidence: any) => evidence.excerpt.includes("blue ball"))!.read_args;
  expect(
    recalled.results
      .flatMap((result: any) => result.evidence)
      .every(
        (evidence: any) =>
          evidence.conversation_session_id === "project-session",
      ),
  ).toBe(true);
  expect(readArgs.scope).toBe("current_project");
  const read = await createReadConversationSessionToolHandler(toolInput)({
    name: "read_conversation_session",
    args: structuredClone(readArgs),
    rawArguments: JSON.stringify(readArgs),
    toolContractVersion: 2,
  });
  expect(read).toMatchObject({
    ok: true,
    mode: "source",
    text: "Luna likes the blue ball.",
  });
});

test("public extraction preserves late multilingual candidate evidence and source byte positions", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-memory-late-evidence-"));
  roots.push(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const memory = await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  const context = { butlerData, target: { kind: "active" as const, expected_generation: descriptor.generation_id }, signal: new AbortController().signal };
  const original = "日本語 العربية e\u0301 🧭 ".repeat(13) + "내 고양이 루나의 영어 이름은 Luna야.";
  const first = await memory.ingestConversationMemory({ context, source: seedTurn(butlerData, "late-evidence", "late-first", original, "Noted.", 1) });
  expect((await advanceUntilSemanticTerminal(memory, context, first.job_id))?.semantic_graph.state).toBe("complete");
  transformExtractionOutput = (output, input) => {
    const candidate = input.candidates.find((item: any) => item.aliases.includes("Luna"));
    output.nodes[0].evidence.push({ unit_ref: candidate.evidence[0].ref, quote: "Luna", occurrence: 0 });
  };
  const second = await memory.ingestConversationMemory({ context, source: seedTurn(butlerData, "late-evidence", "late-second", "Luna likes the blue ball.", "Noted.", 1) });
  expect((await advanceUntilSemanticTerminal(memory, context, second.job_id))?.semantic_graph.state).toBe("complete");
  const input = extractionInputs.at(-1)!;
  const candidate = input.candidates.find((item: any) => item.aliases.includes("Luna"));
  expect(candidate.evidence).toHaveLength(1);
  expect(candidate.evidence[0].text).toBe(original);
  expect(Buffer.byteLength(JSON.stringify(input.candidates))).toBeLessThanOrEqual(8 * 1024);
  const db = openProjectionDb(join(butlerData, "cognition/memory/generations", descriptor.generation_id, "graph.sqlite"));
  try {
    const row = db.query<{ normalized_plan_json: string }, [string]>("SELECT normalized_plan_json FROM memory_projection_windows WHERE window_ref=?").get(input.window_ref)!;
    const evidence = Object.values(JSON.parse(row.normalized_plan_json).evidence).flat() as Array<{ sourceId: string; byteStart: number; byteEnd: number; quote: string }>;
    const originalSource = db.query<{ source_id: string }, [string]>("SELECT source_id FROM memory_chunk_sources WHERE content_hash=?").get(createHash("sha256").update(original).digest("hex"))!;
    const prior = evidence.find((item) => item.sourceId === originalSource.source_id && item.quote === "Luna")!;
    expect(prior.byteStart).toBe(Buffer.byteLength(original.slice(0, original.indexOf("Luna"))));
    expect(Buffer.from(original).subarray(prior.byteStart, prior.byteEnd).toString()).toBe("Luna");
  } finally {
    db.close();
  }
}, 20_000);

test("public extraction supplies closed claim candidates and explicit local reference rules", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-memory-candidate-"));
  roots.push(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const memory = await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  const context = { butlerData, target: { kind: "active" as const, expected_generation: descriptor.generation_id }, signal: new AbortController().signal };
  for (const [index, text] of ["내 고양이 루나의 영어 이름은 Luna야.", "Luna likes the blue ball.", "Luna likes the blue ball."].entries()) {
    const job = await memory.ingestConversationMemory({ context, source: seedTurn(butlerData, "candidate-session", `candidate-turn-${index}`, text, "Noted.", 1) });
    expect((await advanceUntilSemanticTerminal(memory, context, job.job_id))?.semantic_graph.state).toBe("complete");
  }
  const input = extractionInputs.at(-1)!;
  const refs = new Set(input.candidates.map((value: any) => value.ref));
  const claims = input.candidates.filter((value: any) => value.claim?.subject_ref || value.claim?.object_ref);
  expect(claims.length).toBeGreaterThan(0);
  for (const claim of claims) {
    for (const ref of [claim.claim.subject_ref, claim.claim.object_ref]) {
      if (ref) expect(refs.has(ref)).toBe(true);
    }
  }
  const request = extractionRequests.at(-1)!;
  expect(request.instructions).toContain("declared output local_ref, never candidate IDs");
  expect(request.instructions).toContain("Relations require an assertion claim; endpoints equal its subject/object");
}, 20_000);

test("two canonical multilingual episodes reuse explicit alias and recall typed graph evidence", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-memory-t1-"));
  roots.push(butlerData);
  const descriptor = initializeEmptyMemoryGeneration(butlerData);
  const first = seedTurn(
    butlerData,
    "session-a",
    "turn-s1",
    "내 고양이 루나의 영어 이름은 Luna야.",
    "알겠습니다.",
    1,
  );
  const memory =
    await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
  const context = {
    butlerData,
    target: {
      kind: "active" as const,
      expected_generation: descriptor.generation_id,
    },
    signal: new AbortController().signal,
  };
  const firstJob = await memory.ingestConversationMemory({
    context,
    source: first,
  });
  expect(firstJob.source.state).toBe("complete");
  const { pollIteration } =
    await import("../../packages/butler-agent/src/agent/cognition/memory/scripts/sync-consumer.ts");
  expect((await pollIteration({ butlerData })).action).toBe("processed");
  const vectorAttempt = await memory.advanceNextMemoryProjection({ context });
  expect(vectorAttempt?.job_id).toBe(firstJob.job_id);
  expect(vectorAttempt?.semantic_graph.state).toBe("complete");
  expect(vectorAttempt?.node_vectors.state).toBe("partial");
  expect(vectorAttempt?.episode_vectors.state).toBe("pending");
  const graphPath = join(
    butlerData,
    "cognition",
    "memory",
    "generations",
    descriptor.generation_id,
    "graph.sqlite",
  );
  const replayDb = new Database(graphPath);
  const savedPlan = replayDb
    .query<
      { window_ref: string; normalized_plan_json: string },
      []
    >("SELECT window_ref,normalized_plan_json FROM memory_projection_windows WHERE normalized_plan_json IS NOT NULL")
    .get()!;
  const savedNodeIds = replayDb
    .query<{ id: string }, []>("SELECT id FROM entities ORDER BY id")
    .all()
    .map((row) => row.id);
  replayDb
    .query(
      "UPDATE memory_projection_windows SET state='planned' WHERE window_ref=?",
    )
    .run(savedPlan.window_ref);
  replayDb.close();
  for (let quantum = 0; quantum < 16; quantum += 1) {
    expect(["processed", "idle"]).toContain(
      (await pollIteration({ butlerData })).action,
    );
    const stateDb = new Database(graphPath, { readonly: true });
    const state = stateDb
      .query<
        { state: string },
        [string]
      >("SELECT state FROM memory_projection_windows WHERE window_ref=?")
      .get(savedPlan.window_ref)!.state;
    stateDb.close();
    if (state === "complete") break;
  }
  expect(extractionInputs).toHaveLength(1);
  const replayedDb = new Database(graphPath, { readonly: true });
  expect(
    replayedDb
      .query<
        { state: string; normalized_plan_json: string },
        [string]
      >("SELECT state,normalized_plan_json FROM memory_projection_windows WHERE window_ref=?")
      .get(savedPlan.window_ref),
  ).toEqual({
    state: "complete",
    normalized_plan_json: savedPlan.normalized_plan_json,
  });
  expect(
    replayedDb
      .query<{ id: string }, []>("SELECT id FROM entities ORDER BY id")
      .all()
      .map((row) => row.id),
  ).toEqual(savedNodeIds);
  replayedDb.close();

  const second = seedTurn(
    butlerData,
    "session-a",
    "turn-s2",
    "Luna likes the blue ball.",
    "Noted.",
    1,
  );
  const secondJob = await memory.ingestConversationMemory({
    context,
    source: second,
  });
  expect(
    (await advanceUntilSemanticTerminal(memory, context, secondJob.job_id))
      ?.semantic_graph.state,
  ).toBe("complete");

  expect(extractionInputs[1]!.context_units.length).toBeGreaterThan(0);
  expect(
    extractionInputs[1]!.candidates.some((candidate: any) =>
      candidate.aliases.includes("Luna"),
    ),
  ).toBe(true);

  const recallAsOf = new Date(Date.now() + 60_000).toISOString();
  const entityRecall = await memory.recallMemory({
    context,
    cue: "루나",
    includeVector: false,
    includeInternal: false,
    limit: 6,
    scope: "current_project",
    projectFilter: "any",
    projectIds: [],
    sessionIds: [],
    asOf: recallAsOf,
    runtime: {
      sessionId: "query-session",
      turnId: "recall-entity",
      currentUserMessage: "루나",
      nativeOperationId: "recall-entity-op",
      projectId: "project-a",
    },
  });
  const claimRecall = await memory.recallMemory({
    context,
    cue: "Luna likes",
    includeVector: false,
    includeInternal: false,
    limit: 6,
    scope: "current_project",
    projectFilter: "any",
    projectIds: [],
    sessionIds: [],
    asOf: recallAsOf,
    runtime: {
      sessionId: "session-a",
      turnId: "recall-claim",
      currentUserMessage: "Luna likes",
      nativeOperationId: "recall-claim-op",
      projectId: "project-a",
    },
  });
  expect(entityRecall.results.length).toBeGreaterThanOrEqual(2);
  expect(claimRecall.results.length).toBeGreaterThanOrEqual(1);
  expect(claimRecall.coverage.vectors.state).toBe("disabled_by_request");
  const directClaim = claimRecall.results.find((result: any) =>
    result.evidence.some((evidence: any) =>
      evidence.excerpt.includes("blue ball"),
    ),
  )!;
  expect(directClaim.association_path).toEqual([]);
  const indirectRecall = await memory.recallMemory({
    context,
    cue: "likes",
    includeVector: false,
    includeInternal: false,
    limit: 6,
    scope: "current_project",
    projectFilter: "any",
    projectIds: [],
    sessionIds: [],
    asOf: recallAsOf,
    runtime: {
      sessionId: "query-session",
      turnId: "recall-indirect",
      currentUserMessage: "likes",
      nativeOperationId: "recall-indirect-op",
      projectId: "project-a",
    },
  });
  const indirectS1 = indirectRecall.results.find((result: any) =>
    result.evidence.some((evidence: any) =>
      evidence.excerpt.includes("영어 이름"),
    ),
  )!;
  expect(indirectS1.association_path.length).toBeGreaterThan(0);

  const graph = new Database(graphPath, { readonly: true });
  try {
    for (const edge of indirectS1.association_path) {
      expect(
        graph
          .query<
            { found: number },
            [string, string, string]
          >("SELECT 1 found FROM edges WHERE source_node_id=? AND target_node_id=? AND rel_type=? LIMIT 1")
          .get(edge.from, edge.to, edge.relation)?.found,
      ).toBe(1);
    }
    const stored = graph
      .query<
        {
          edge_id: string;
          source_node_id: string;
          target_node_id: string;
          rel_type: string;
          claim_node_id: string | null;
        },
        []
      >(
        "SELECT edge_id,source_node_id,target_node_id,rel_type,claim_node_id FROM edges WHERE rel_type='has_subject' ORDER BY edge_id LIMIT 1",
      )
      .get()!;
    const reverse = expandGraph(
      [stored.target_node_id],
      (nodeId) => ({
        edges: graph
          .query<
            {
              edge_id: string;
              source_node_id: string;
              target_node_id: string;
              rel_type: string;
              claim_node_id: string | null;
            },
            [string, string]
          >(
            "SELECT edge_id,source_node_id,target_node_id,rel_type,claim_node_id FROM edges WHERE source_node_id=? OR target_node_id=? ORDER BY edge_id",
          )
          .all(nodeId, nodeId)
          .map((edge) => ({
            edgeId: edge.edge_id,
            sourceNodeId: edge.source_node_id,
            targetNodeId: edge.target_node_id,
            relation: edge.rel_type,
            claimNodeId: edge.claim_node_id,
            support: 1,
          })),
        truncated: false,
      }),
      Date.now() + 1_000,
    ).paths.get(stored.source_node_id)!;
    expect(reverse[0]).toEqual({
      from: stored.source_node_id,
      relation: stored.rel_type,
      to: stored.target_node_id,
      traversed_reverse: true,
    });
    expect(
      graph
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) count FROM memory_vector_units WHERE state='failed' AND error_code='memory_embedding_failed'")
        .get()!.count,
    ).toBeGreaterThan(0);
    expect(
      graph
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) count FROM edges WHERE rel_type='has_subject'")
        .get()!.count,
    ).toBeGreaterThan(0);
    expect(
      graph
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) count FROM edges WHERE rel_type='has_object'")
        .get()!.count,
    ).toBeGreaterThan(0);
    expect(
      graph
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) count FROM edges WHERE rel_type='likes'")
        .get()!.count,
    ).toBeGreaterThan(0);
    expect(
      graph
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) count FROM memory_projection_windows WHERE provider_evidence_json IS NOT NULL")
        .get()!.count,
    ).toBe(2);
  } finally {
    graph.close();
  }

  const evidence = claimRecall.results[0]!.evidence[0]!;
  const source = memory.resolveMemorySource({
    context,
    sourceRef: evidence.read_args.source_ref,
    maxChars: evidence.read_args.max_chars,
  });
  expect(source.source_hash).toMatch(/^[a-f0-9]{64}$/u);
  expect(source.text.length).toBeGreaterThan(0);

  const { createRecallMemoryToolHandler } =
    await import("../../packages/butler-agent/src/agent/tools/memory/recall_memory/executor.ts");
  const { createReadConversationSessionToolHandler } =
    await import("../../packages/butler-agent/src/agent/tools/memory/read_conversation_session/executor.ts");
  const toolInput = {
    butlerHome: butlerData,
    butlerData,
    turnId: "query-turn",
    sessionId: "session-a",
    projectId: "project-a",
    currentUserMessage: "Luna likes",
  };
  const nativeRecall = await createRecallMemoryToolHandler(toolInput)(
    {
      name: "recall_memory",
      args: { cue: "Luna likes", include_vector: false },
      rawArguments: JSON.stringify({
        cue: "Luna likes",
        include_vector: false,
      }),
      toolContractVersion: 2,
    },
    { effectOccurrenceId: "t1-native-recall" },
  );
  const readArgs = (nativeRecall as any).results[0]!.evidence[0]!.read_args;
  const nativeRead = await createReadConversationSessionToolHandler(toolInput)({
    name: "read_conversation_session",
    args: readArgs,
    rawArguments: JSON.stringify(readArgs),
    toolContractVersion: 2,
  });
  expect(nativeRead).toMatchObject({
    ok: true,
    mode: "source",
    source_ref: readArgs.source_ref,
    source_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });

  const beforeReuse = new Database(graphPath, { readonly: true });
  const originalClaim = beforeReuse
    .query<
      { id: string; properties: string },
      []
    >("SELECT id,properties FROM entities WHERE type='preference' ORDER BY id LIMIT 1")
    .get()!;
  beforeReuse.close();
  let reuseInput: Record<string, any> | null = null;
  let reuseOutput: Record<string, any> | null = null;
  transformExtractionOutput = (output, input) => {
    const assistant = input.source_units.find(
      (unit: any) =>
        unit.role === "assistant" && unit.text === "Luna likes the blue ball.",
    );
    if (!assistant) return;
    const luna = input.candidates.find(
      (candidate: any) =>
        candidate.type === "entity" && candidate.aliases.includes("Luna"),
    );
    const ball = input.candidates.find(
      (candidate: any) =>
        candidate.type === "entity" && candidate.aliases.includes("blue ball"),
    );
    const preference = input.candidates.find(
      (candidate: any) =>
        candidate.type === "preference" &&
        candidate.evidence.some((item: any) =>
          item.text.includes("Luna likes the blue ball."),
        ),
    );
    expect(luna).toBeDefined();
    expect(ball).toBeDefined();
    expect(preference).toBeDefined();
    const current = (quote: string) => ({
      unit_ref: assistant.ref,
      quote,
      occurrence: 0,
    });
    const prior = (candidate: any) => ({
      unit_ref: candidate.evidence[0].ref,
      quote: candidate.evidence[0].text,
      occurrence: 0,
    });
    const reuse = (candidate: any, quote: string) => ({
      kind: "reuse",
      node_ref: candidate.ref,
      reason: "explicit_alias",
      evidence: [current(quote), prior(candidate)],
    });
    const next = {
      schema: "butler.memory-extract-output.v2",
      window_ref: input.window_ref,
      disposition: "processed",
      covered_unit_refs: input.source_units.map((unit: any) => unit.ref),
      nodes: [
        {
          local_ref: "luna",
          type: "entity",
          label: "Luna",
          resolution: reuse(luna, "Luna"),
          aliases: [],
          evidence: [current("Luna")],
        },
        {
          local_ref: "ball",
          type: "entity",
          label: "blue ball",
          resolution: reuse(ball, "blue ball"),
          aliases: [],
          evidence: [current("blue ball")],
        },
      ],
      claims: [
        {
          local_ref: "preference",
          type: "preference",
          resolution: reuse(preference, "Luna likes the blue ball."),
          statement: "Luna likes the blue ball.",
          subject_ref: "luna",
          object_ref: "ball",
          speech_act: "assertion",
          basis: "assistant_statement",
          polarity: "positive",
          condition: null,
          valid_from: null,
          valid_to: null,
          salience: "normal",
          evidence: [current("Luna likes the blue ball.")],
        },
      ],
      relations: [
        {
          from_ref: "luna",
          to_ref: "ball",
          relation: "likes",
          claim_ref: "preference",
          evidence: [current("Luna likes the blue ball.")],
        },
      ],
      corrections: [],
      summary: {
        text: "Luna likes the blue ball.",
        evidence: [current("Luna likes the blue ball.")],
      },
    };
    for (const key of Object.keys(output)) delete output[key];
    Object.assign(output, next);
    reuseInput = structuredClone(input);
    reuseOutput = structuredClone(next);
  };
  const third = seedTurn(
    butlerData,
    "session-a",
    "turn-s3",
    "What does Luna like?",
    "Luna likes the blue ball.",
    1,
  );
  const thirdJob = await memory.ingestConversationMemory({
    context,
    source: third,
  });
  let thirdProgress: Awaited<
    ReturnType<typeof memory.advanceNextMemoryProjection>
  > = null;
  for (let attempt = 0; attempt < 20 && !reuseOutput; attempt++) {
    thirdProgress = await memory.advanceNextMemoryProjection({ context });
  }
  expect(reuseInput).not.toBeNull();
  expect(reuseOutput).not.toBeNull();
  expect(thirdProgress?.job_id).toBe(thirdJob.job_id);
  expect(thirdProgress?.semantic_graph.state).toBe("complete");
  const requestContract = extractionRequests.at(-1)!;
  expect(requestContract.instructions).toContain(
    "Current claim/relation evidence determines basis",
  );
  expect(requestContract.instructions).toContain(
    "resolution.evidence needs both a current quote and a historical quote from that candidate's own evidence",
  );
  expect(requestContract.instructions).toContain("Historical evidence does not replace current evidence or determine its basis");
  const wrongBasis = structuredClone(reuseOutput!);
  wrongBasis.claims[0].basis = "user_statement";
  expect(() =>
    normalizeAndValidatePlan(
      null as never,
      reuseInput as never,
      wrongBasis as never,
    ),
  ).toThrow("memory_extract_invalid_basis");

  const afterReuse = new Database(graphPath, { readonly: true });
  try {
    const preservedClaim = afterReuse
      .query<
        { id: string; properties: string },
        [string]
      >("SELECT id,properties FROM entities WHERE id=?")
      .get(originalClaim.id)!;
    expect(preservedClaim.id).toBe(originalClaim.id);
    expect(preservedClaim.properties).toBe(originalClaim.properties);
    expect(
      afterReuse
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) count FROM entities WHERE type='preference'")
        .get()!.count,
    ).toBe(1);
    expect(
      afterReuse
        .query<
          { count: number },
          [string, string]
        >("SELECT COUNT(*) count FROM entity_mentions m JOIN memory_chunk_sources s ON s.source_id=m.source_id JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision WHERE m.entity_id=? AND c.conversation_turn_id=? AND s.role='assistant'")
        .get(originalClaim.id, "turn-s3")!.count,
    ).toBe(1);
    expect(
      afterReuse
        .query<
          { turn_id: string; role: string; basis: string },
          []
        >("SELECT c.conversation_turn_id turn_id,s.role,ee.basis FROM edges e JOIN edge_evidence ee ON ee.edge_id=e.edge_id JOIN memory_chunk_sources s ON s.source_id=ee.chunk_source_id JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision WHERE e.rel_type='likes' ORDER BY c.conversation_turn_id")
        .all(),
    ).toEqual([
      { turn_id: "turn-s2", role: "user", basis: "user_statement" },
      {
        turn_id: "turn-s3",
        role: "assistant",
        basis: "assistant_statement",
      },
    ]);
  } finally {
    afterReuse.close();
  }
});

async function advanceUntilSemanticTerminal(
  memory: { advanceNextMemoryProjection(input: any): Promise<any> },
  context: unknown,
  jobId: string,
): Promise<any> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const progress = await memory.advanceNextMemoryProjection({ context });
    if (
      progress?.job_id === jobId &&
      (["complete", "failed"].includes(progress.semantic_graph.state) ||
        (progress.semantic_graph.state === "partial" && progress.semantic_graph.pending_units === 0))
    )
      return progress;
  }
  throw new Error(
    `semantic projection did not reach a terminal state: ${jobId}`,
  );
}

async function advanceUntilHotCacheComplete(
  memory: { advanceNextMemoryProjection(input: any): Promise<any> },
  context: unknown,
  jobId: string,
): Promise<any> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const progress = await memory.advanceNextMemoryProjection({ context });
    if (progress?.job_id === jobId && progress.hot_cache.state === "complete") return progress;
  }
  throw new Error(`hot cache did not complete: ${jobId}`);
}

async function advanceUntilSemanticAndHotCacheComplete(
  memory: { advanceNextMemoryProjection(input: any): Promise<any> },
  context: unknown,
  jobId: string,
): Promise<any> {
  const target = (context as any)?.target;
  const persisted = () => {
    const generation = target?.kind === "active" ? target.expected_generation : target?.generation_id;
    if (!generation) return null;
    const db = openProjectionDb(join(
      (context as any).butlerData, "cognition", "memory", "generations", generation, "graph.sqlite",
    ), true);
    try { return progressFromDb(db, jobId); }
    finally { db.close(); }
  };
  const complete = (progress: any) =>
    progress?.semantic_graph.state === "complete" && progress.hot_cache.state === "complete";
  let last: unknown = null;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const before = persisted();
    if (complete(before)) return before;
    const progress = await memory.advanceNextMemoryProjection({ context });
    if (progress) last = progress;
    if (progress?.job_id === jobId && complete(progress)) return progress;
    const after = persisted();
    if (complete(after)) return after;
  }
  const diagnostics = target?.kind === "rebuild" ? (() => {
    const db = new Database(join((context as any).butlerData, "cognition", "memory", "generations", target.generation_id, "graph.sqlite"), { readonly: true });
    try { return db.query("SELECT state,error_code,attempt_count FROM memory_projection_windows WHERE job_id=?").all(jobId); }
    finally { db.close(); }
  })() : [];
  throw new Error(`semantic and hot cache stages did not complete: ${jobId}; last=${JSON.stringify(last)}; windows=${JSON.stringify(diagnostics)}`);
}

async function startCheckedEmbeddingServer(
  socketPath: string,
  beforeReply?: () => Promise<void>,
): Promise<ReturnType<typeof createServer>> {
  const server = createServer((socket) => {
    let payload = "";
    socket.on("data", (chunk) => {
      payload += chunk.toString();
      if (!payload.includes("\n")) return;
      const request = JSON.parse(payload.trim()) as { texts?: unknown };
      const texts = request.texts;
      if (!Array.isArray(texts) || texts.some((text) => typeof text !== "string")) {
        socket.destroy(new Error("invalid embedding request"));
        return;
      }
      void (async () => {
      await beforeReply?.();
      socket.end(`${JSON.stringify({
        embeddings: texts.map(() => [1, 0]), token_counts: texts.map(() => 2),
        embedded_texts: texts, omitted_count: 0,
        metadata: {
          model: "test/bge-m3", dimension: 2, pooling: "cls", normalize: true,
          version: "a".repeat(64), max_tokens: 8192, transformers_version: "test",
          node_runtime_version: process.version, bun_runtime_version: Bun.version,
          tokenizer_asset_sha256: "b".repeat(64), model_asset_sha256: "c".repeat(64),
        },
      })}\n`);
      })().catch((error) => socket.destroy(error instanceof Error ? error : new Error(String(error))));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

function assembledMemoryPrompt(butlerData: string, sessionId: string, projectId: string): string {
  return new PromptAssembler({ butlerHome: join(butlerData, "home"), butlerData }).buildTurnContext({
    binding: {
      sessionId, role: "butler", projectId, workspacePath: join(butlerData, "workspace"),
      runtimeAdapterId: "codex-api", modelProviderId: "test", modelRef: "test/model",
      transportBindings: [], metadata: {}, lifecycleState: "active",
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    },
    envelope: {
      eventId: "test:t5b", transport: "mock", accountId: "default",
      peer: { kind: "dm", id: "peer" }, sender: { id: "user" },
      message: { id: "message", text: "continue", timestamp: new Date(0).toISOString() },
    },
  });
}

function seedTurn(
  butlerData: string,
  sessionId: string,
  turnId: string,
  userText: string,
  assistantText: string,
  generation: number,
  origins: {
    user: "user_input" | "internal_control" | "unknown";
    assistant: "assistant_public" | "internal_control" | "unknown";
    publicAdmission?: { eventId: string };
  } = { user: "user_input", assistant: "assistant_public" },
  projectId: string | null = "project-a",
) {
  const store = new AgentConversationStore({ butlerData });
  try {
    const turn = store.beginTurn({
      gateway: "app",
      externalSessionId: sessionId,
      sessionId,
      projectId,
      actor: "user",
      turnId,
      requestId: origins.publicAdmission?.eventId,
    });
    if (origins.publicAdmission) {
      new NativeInboundQueue(butlerData).enqueue({
        eventId: origins.publicAdmission.eventId,
        transport: "app",
        accountId: "default",
        peer: { kind: "dm", id: sessionId },
        sender: { id: "user" },
        message: {
          id: origins.publicAdmission.eventId,
          text: userText,
          timestamp: new Date(0).toISOString(),
        },
        routingHints: { sessionId, turnId: turn.id },
      });
    }
    const user = store.appendUserMessage({
      sessionId,
      turnId: turn.id,
      text: userText,
      originKind: origins.user,
      originRef: origins.publicAdmission?.eventId ?? `app:${turnId}:user`,
      sourceGateway: origins.publicAdmission ? "app" : undefined,
      sourceRef: origins.publicAdmission?.eventId,
    });
    const assistant = store.appendAssistantMessage({
      sessionId,
      turnId: turn.id,
      text: assistantText,
      originKind: origins.assistant,
      originRef: `app:${turnId}:assistant`,
    });
    store.finalizeTurn({
      turnId,
      status: "complete",
      outcomeCapsule: {
        sessionId,
        turnId,
        generation,
        outcome: "delivered",
        requestMessageId: user.id,
        publicAssistantMessageId: assistant.id,
        providerId: "test",
        modelRef: "test/model",
      },
    });
    return {
      kind: "conversation_turn" as const,
      session_id: sessionId,
      turn_id: turnId,
      outcome_generation: generation,
      request_message_id: user.id,
      assistant_message_id: assistant.id,
    };
  } finally {
    store.close();
  }
}

function extractFor(input: Record<string, any>): Record<string, any> {
  if (Array.isArray(input.parts)) {
    return {
      status: "processed",
      entities: input.speaker === "user"
        ? [{ name: "Luna", evidence: [input.parts[0].id] }]
        : [],
      items: [],
      attributes: [],
    };
  }
  if (Array.isArray(input.targets)) {
    return {
      decisions: input.targets.map((target: any) => ({
        target: target.target,
        candidate: null,
        span: null,
        support: [],
      })),
    };
  }
  const source =
    input.source_units.find((unit: any) => unit.role === "user") ??
    input.source_units[0];
  const quote = (text: string) => [
    { unit_ref: source.ref, quote: text, occurrence: 0 },
  ];
  const common = {
    schema: "butler.memory-extract-output.v2",
    window_ref: input.window_ref,
    disposition: "processed",
    covered_unit_refs: input.source_units.map((unit: any) => unit.ref),
    corrections: [],
    summary: { text: source.text, evidence: quote(source.text) },
  };
  if (source.text.includes("blue ball")) {
    const candidate = input.candidates.find((item: any) =>
      item.aliases.includes("Luna"),
    );
    const candidateEvidence = candidate.evidence[0];
    return {
      ...common,
      nodes: [
        {
          local_ref: "luna",
          type: "entity",
          label: "Luna",
          resolution: {
            kind: "reuse",
            node_ref: candidate.ref,
            reason: "explicit_alias",
            evidence: [
              ...quote("Luna"),
              { unit_ref: candidateEvidence.ref, quote: "Luna", occurrence: 0 },
            ],
          },
          aliases: [],
          evidence: quote("Luna"),
        },
        {
          local_ref: "ball",
          type: "entity",
          label: "blue ball",
          resolution: {
            kind: "create",
            provisional: false,
            identity_scope: "user",
          },
          aliases: [],
          evidence: quote("blue ball"),
        },
      ],
      claims: [
        {
          local_ref: "preference",
          type: "preference",
          resolution: {
            kind: "create",
            provisional: false,
            identity_scope: "user",
          },
          statement: source.text,
          subject_ref: "luna",
          object_ref: "ball",
          speech_act: "assertion",
          basis: "user_statement",
          polarity: "positive",
          condition: null,
          valid_from: null,
          valid_to: null,
          salience: "normal",
          evidence: quote(source.text),
        },
      ],
      relations: [
        {
          from_ref: "luna",
          to_ref: "ball",
          relation: "likes",
          claim_ref: "preference",
          evidence: quote(source.text),
        },
      ],
    };
  }
  return {
    ...common,
    nodes: [
      {
        local_ref: "luna",
        type: "entity",
        label: "Luna",
        resolution: {
          kind: "create",
          provisional: false,
          identity_scope: "user",
        },
        aliases: [
          { text: "루나", evidence: quote("루나") },
          { text: "Luna", evidence: quote("Luna") },
        ],
        evidence: quote(source.text),
      },
    ],
    claims: [],
    relations: [],
  };
}
