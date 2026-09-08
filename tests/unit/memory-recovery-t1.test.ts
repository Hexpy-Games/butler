import { afterEach, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { initializeEmptyMemoryGeneration } from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";
import { extractOutputSchema } from "../../packages/butler-agent/src/agent/cognition/memory/projection/extractor.ts";
import { validateJsonObjectSchema } from "../../packages/butler-agent/src/agent/tools/schema-validation.ts";
import { unicodeCaseFold } from "../../packages/butler-agent/src/agent/cognition/memory/projection/unicode.ts";
import { openProjectionDb } from "../../packages/butler-agent/src/agent/cognition/memory/projection/store.ts";
import { normalizeAndValidatePlan } from "../../packages/butler-agent/src/agent/cognition/memory/projection/plan.ts";
import { publishConversationCompletionObservation } from "../../packages/butler-agent/src/agent/cognition/continuity/completion-observation.ts";
import { peek } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/queue.ts";
import { createToolCallToolHandler } from "../../packages/butler-agent/src/agent/tools/tool-bridge/tool_call/executor.ts";
import { recallMemoryToolDefinition } from "../../packages/butler-agent/src/agent/tools/memory/recall_memory/definition.ts";
import {
  acquireConsolidationLock,
  releaseConsolidationLock,
  sweepStaleLocks,
} from "../../packages/butler-agent/src/agent/cognition/memory/scripts/lib/lock.ts";

const roots: string[] = [];
let extractionInputs: Array<Record<string, any>> = [];
let duringExtraction: (() => void) | null = null;
let transformExtractionOutput:
  | ((output: Record<string, any>, input: Record<string, any>) => void)
  | null = null;

mock.module(
  "../../packages/butler-agent/src/integrations/providers/runtime.ts",
  () => ({
    runPromptTextWithUsage: async (request: {
      prompt: string;
      model: string;
      providerRetryAttempts: number;
    }) => {
      expect(request.providerRetryAttempts).toBe(0);
      const input = JSON.parse(request.prompt) as Record<string, any>;
      extractionInputs.push(input);
      duringExtraction?.();
      const output = extractFor(input);
      transformExtractionOutput?.(output, input);
      return {
        text: JSON.stringify(output),
        model: request.model,
        usage: {
          promptTokens: 100,
          cachedTokens: 0,
          outputTokens: 50,
          totalTokens: 150,
        },
      };
    },
  }),
);

afterEach(() => {
  extractionInputs = [];
  duringExtraction = null;
  transformExtractionOutput = null;
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }));
});

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

test("shape-valid invalid quote preserves provider evidence before plan rejection", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-memory-invalid-quote-"));
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
    expect(row.state).toBe("failed");
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
  } finally {
    graph.close();
  }
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
  const path = join(root, "writer.lock");
  const lease = acquireConsolidationLock(path, { purpose: "test_owner" });
  expect(lease).not.toBeNull();
  expect(
    acquireConsolidationLock(path, { staleAgeMs: 0, purpose: "other" }),
  ).toBeNull();
  releaseConsolidationLock(path, {
    owner_nonce: "wrong",
    purpose: "test_owner",
  });
  expect(existsSync(path)).toBe(true);
  releaseConsolidationLock(path, lease!);
  expect(existsSync(path)).toBe(false);

  const stale = JSON.stringify({
    pid: 99_999_999,
    startedAt: "2000-01-01T00:00:00.000Z",
    host: hostname(),
    owner_nonce: "dead-owner",
    purpose: "stale-owner",
  });
  writeFileSync(path, stale);
  expect(
    acquireConsolidationLock(path, { purpose: "replacement" }),
  ).toBeNull();
  expect(sweepStaleLocks(root)).toEqual([]);
  expect(await Bun.file(path).text()).toBe(stale);
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
        .query("UPDATE conversation_parts SET content_json=? WHERE message_id=?")
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
        .query<{ count: number }, []>("SELECT COUNT(*) count FROM memory_chunks")
        .get()!.count,
    ).toBe(0);
  } finally {
    graph.close();
  }
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
    await memory.ingestConversationMemory({ context, source });
    await memory.advanceNextMemoryProjection({ context });
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

test("validated corrections remain explicitly incomplete until T3 semantics", async () => {
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
  await memory.ingestConversationMemory({
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
  await memory.advanceNextMemoryProjection({ context });
  await memory.ingestConversationMemory({
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
  await memory.advanceNextMemoryProjection({ context });
  let correctionInput: Record<string, any> | null = null;
  let correctionOutput: Record<string, any> | null = null;
  transformExtractionOutput = (output, input) => {
    const source = input.source_units.find((unit: any) => unit.role === "user");
    const previousClaim = input.candidates.find(
      (candidate: any) => candidate.type === "preference",
    );
    if (!previousClaim) throw new Error("missing prior claim candidate");
    output.corrections = [
      {
        previous_claim_ref: previousClaim.ref,
        replacement_claim_ref: "preference",
        relation: "supersedes",
        effective_at: null,
        evidence: [
          { unit_ref: source.ref, quote: source.text, occurrence: 0 },
        ],
      },
    ];
    correctionInput = structuredClone(input);
    correctionOutput = structuredClone(output);
  };
  const source = seedTurn(
    butlerData,
    "correction-session",
    "correction-claim",
    "Luna likes the blue ball.",
    "Noted.",
    1,
  );
  const registered = await memory.ingestConversationMemory({ context, source });
  expect(registered.source.state).toBe("complete");
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
        .query<
          { error_code: string },
          []
        >("SELECT error_code FROM memory_projection_windows WHERE state='failed'")
        .get()!.error_code,
    ).toBe("memory_extract_corrections_unsupported");
  } finally {
    graph.close();
  }
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
  entityPrevious.corrections[0].previous_claim_ref = correctionInput!.candidates
    .find((candidate: any) => candidate.type === "entity")!.ref;
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
    await memory.ingestConversationMemory({ context, source });
    await memory.advanceNextMemoryProjection({ context });
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
  };
  const recalled = (await createRecallMemoryToolHandler(toolInput)({
    name: "recall_memory",
    args: { cue: "Luna likes", include_vector: false },
    rawArguments: JSON.stringify({
      cue: "Luna likes",
      include_vector: false,
    }),
    toolContractVersion: 2,
  })) as any;
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
  expect(await memory.advanceNextMemoryProjection({ context })).toBeNull();
  const graphPath = join(
    butlerData,
    "cognition",
    "memory",
    "generations",
    descriptor.generation_id,
    "graph.sqlite",
  );
  const replayDb = new Database(graphPath);
  replayDb.query("UPDATE memory_projection_windows SET state='planned'").run();
  replayDb.close();
  expect((await pollIteration({ butlerData })).action).toBe("processed");
  expect(extractionInputs).toHaveLength(1);

  const second = seedTurn(
    butlerData,
    "session-a",
    "turn-s2",
    "Luna likes the blue ball.",
    "Noted.",
    1,
  );
  await memory.ingestConversationMemory({ context, source: second });
  expect(
    (await memory.advanceNextMemoryProjection({ context }))?.semantic_graph
      .state,
  ).toBe("complete");

  expect(extractionInputs[1]!.context_units.length).toBeGreaterThan(0);
  expect(
    extractionInputs[1]!.candidates.some((candidate: any) =>
      candidate.aliases.includes("Luna"),
    ),
  ).toBe(true);

  const entityRecall = memory.recallMemory({
    context,
    cue: "루나",
    includeVector: false,
    limit: 6,
    sessionId: "session-a",
    projectId: "project-a",
  });
  const claimRecall = memory.recallMemory({
    context,
    cue: "Luna likes",
    includeVector: false,
    limit: 6,
    sessionId: "session-a",
    projectId: "project-a",
  });
  expect(entityRecall.results.length).toBeGreaterThanOrEqual(2);
  expect(claimRecall.results.length).toBeGreaterThanOrEqual(1);
  expect(claimRecall.coverage.vectors.state).toBe("disabled_by_request");
  expect(
    claimRecall.results.some((result: any) =>
      result.association_path.some((edge: any) =>
        ["likes", "has_subject", "has_object"].includes(edge.relation),
      ),
    ),
  ).toBe(true);

  const graph = new Database(graphPath, { readonly: true });
  try {
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
  };
  const nativeRecall = await createRecallMemoryToolHandler(toolInput)({
    name: "recall_memory",
    args: { cue: "Luna likes", include_vector: false },
    rawArguments: JSON.stringify({
      cue: "Luna likes",
      include_vector: false,
    }),
    toolContractVersion: 2,
  });
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
});

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
    });
    const user = store.appendUserMessage({
      sessionId,
      turnId: turn.id,
      text: userText,
      originKind: origins.user,
      originRef: `app:${turnId}:user`,
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
