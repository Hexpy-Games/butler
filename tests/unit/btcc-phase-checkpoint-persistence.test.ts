import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SqlitePhaseConversationStore } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/phase-conversation-store.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import {
  objectSchema,
  runPhaseConversation,
  type OperationRequest,
  type PhaseEnvelope,
  type PhaseRunBinding,
} from "../../packages/butler-agent/src/agent/btcc/core/index.ts";

const databases: Database[] = [];

afterEach(() => databases.splice(0).forEach((db) => db.close()));

describe("BTCC phase checkpoint persistence", () => {
  test("atomically appends exact provider rounds, operations, and pending submission", async () => {
    const { db, store, binding } = fixture();
    const envelope = phaseEnvelope(binding);
    const request = observationRequest();
    const identity = selectedModel();
    const phaseContinuity = {
      objectiveState: "Inspect the current repository state.",
      decisions: ["Use the accepted workspace scope."],
      unresolved: ["The current file content is unknown."],
      nextOperationPurpose: "Read the current file once.",
      publicActivity: {
        summary: "현재 파일의 내용을 확인하고 있습니다.",
        rationale: "계획을 현재 구현 상태에 맞추기 위해 필요합니다.",
        nextStep: "확인한 내용으로 다음 작업 범위를 결정합니다.",
      },
    };

    const operationRound = await store.appendOperationRound({
      binding,
      envelope,
      requests: [request],
      phaseContinuity,
      actualIdentity: identity,
    });
    const pending = await store.restore(operationRound);
    expect(pending.pendingOperationRound?.requests).toEqual([request]);
    expect(pending.pendingOperationRound?.phaseContinuity).toEqual(phaseContinuity);

    const observation = {
      requestId: request.requestId,
      request,
      outcome: "observed" as const,
      observationRef: { id: "observation-1", sha256: "observation-sha" },
      content: "canonical observation",
    };
    const observed = await store.appendOperationResults({
      binding: operationRound,
      results: [{ request, result: observation }],
    });
    const product = { kind: "goal_contract_candidate", exact: "product bytes" };
    const pendingSubmission = await store.appendPhaseSubmission({
      binding: observed,
      envelope: phaseEnvelope(observed),
      submission: { kind: "goal_contract_candidate", exact: "submission bytes" },
      actualIdentity: identity,
    });
    const submitted = await store.acceptPhaseProduct({
      binding: pendingSubmission,
      product,
    });

    expect(submitted.checkpointRevision).toBe(5);
    const restored = await store.restore<typeof product>(binding);
    expect(restored.binding.checkpointRevision).toBe(5);
    expect(restored.acceptedProduct).toEqual(product);
    expect(restored.operationResults).toHaveLength(1);
    expect(restored.latestOperationResultRefs).toEqual([
      restored.operationResults[0]?.resultRef,
    ]);
    expect(restored.phaseContinuity).toEqual(phaseContinuity);
    expect(restored.operationResults[0]).toMatchObject({
      request,
      outcome: observation.outcome,
      observationRef: observation.observationRef,
      preview: observation.content,
      omittedBytes: 0,
    });
    expect(restored.pendingOperationRound).toBeUndefined();

    const final = db.query<{
      provider_round_json: string;
      pending_submission_json: string;
      product_bundle_json: string;
      status: string;
    }, []>(`
      SELECT provider_round_json, pending_submission_json,
        product_bundle_json, status
      FROM btcc_phase_checkpoint_revisions
      ORDER BY checkpoint_revision DESC LIMIT 1
    `).get();
    expect(final?.status).toBe("accepted_boundary");
    const provider = db.query<{ provider_round_json: string; pending_submission_json: string }, []>(`
      SELECT provider_round_json, pending_submission_json
      FROM btcc_phase_checkpoint_revisions WHERE status = 'pending_boundary'
    `).get();
    expect(JSON.parse(provider!.provider_round_json)).toEqual({
      kind: "phase_submission",
      submission: { kind: "goal_contract_candidate", exact: "submission bytes" },
      actualIdentity: identity,
    });
    expect(JSON.parse(provider!.pending_submission_json).submission).toEqual({
      kind: "goal_contract_candidate", exact: "submission bytes",
    });
    expect(JSON.parse(final!.product_bundle_json)).toEqual(product);
    expect(db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM btcc_phase_model_rounds
    `).get()?.count).toBe(2);
  });

  test("adopts a durable pending submission without another model call", async () => {
    const { store, binding } = fixture();
    const product = { kind: "accepted", value: "durable" };
    await store.appendPhaseSubmission({
      binding,
      envelope: phaseEnvelope(binding),
      submission: product,
      actualIdentity: selectedModel(),
    });
    let modelCalls = 0;
    const adopted = await runPhaseConversation({
      binding,
      modelSelection: selectedModel(),
      context: phaseEnvelope(binding).context,
      phaseContract: {
        phase: "conception_deliberation",
        operationSurface: "authorized",
        objective: "adopt_durable_submission",
        duties: [],
        prohibitions: [],
      },
      codec: { submissionSchema: objectSchema({}), decode: () => product },
      store,
      model: {
        runRound: async () => {
          modelCalls += 1;
          throw new Error("durable submission must be adopted");
        },
      },
      operations: { perform: async () => { throw new Error("unexpected operation"); } },
      operationAuthority: { observationScopeRefs: [], mutation: { kind: "forbidden" } },
      executionPermit: activePermit(),
    });
    expect(adopted).toEqual(product);
    expect(modelCalls).toBe(0);
  });

  test("stores the same local request ID independently in later provider rounds", async () => {
    const { db, store, binding } = fixture();
    const first = observationRequest();
    const firstRound = await store.appendOperationRound({
      binding,
      envelope: phaseEnvelope(binding),
      requests: [first],
      actualIdentity: selectedModel(),
    });
    const afterFirst = await store.appendOperationResults({
      binding: firstRound,
      results: [{ request: first, result: observation(first, "first") }],
    });
    const corrected = { ...first, input: { query: "corrected" } };
    const secondRound = await store.appendOperationRound({
      binding: afterFirst,
      envelope: phaseEnvelope(afterFirst),
      requests: [corrected],
      actualIdentity: selectedModel(),
    });
    await store.appendOperationResults({
      binding: secondRound,
      results: [{ request: corrected, result: observation(corrected, "second") }],
    });

    expect(db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM btcc_phase_operation_result_links
    `).get()?.count).toBe(2);
    expect((await store.restore(binding)).operationResults.map((item) => item.preview))
      .toEqual(["first", "second"]);
  });

  test("does not persist a malformed phase submission as a resumable boundary", async () => {
    const { store, binding } = fixture();
    let modelCalls = 0;
    const command = {
      binding,
      modelSelection: selectedModel(),
      context: phaseEnvelope(binding).context,
      phaseContract: {
        phase: "conception_deliberation" as const,
        operationSurface: "authorized" as const,
        objective: "persist_before_decode",
        duties: [], prohibitions: [],
      },
      codec: {
        submissionSchema: objectSchema({}),
        decode: () => { throw new Error("malformed exact submission"); },
      },
      store,
      model: {
        runRound: async () => {
          modelCalls += 1;
          return {
            kind: "phase_submission" as const,
            submission: { malformed: true },
            actualIdentity: selectedModel(),
          };
        },
      },
      operations: { perform: async () => { throw new Error("unexpected operation"); } },
      operationAuthority: { observationScopeRefs: [], mutation: { kind: "forbidden" as const } },
      executionPermit: activePermit(),
    };
    await expect(runPhaseConversation(command)).rejects.toMatchObject({
      code: "provider_phase_submission_invalid",
    });
    await expect(runPhaseConversation(command)).rejects.toMatchObject({
      code: "provider_phase_submission_invalid",
    });
    expect(modelCalls).toBe(2);
    const restored = await store.restore(binding);
    expect(restored.pendingSubmissionRound).toBeUndefined();
  });
});

function observation(
  request: Extract<OperationRequest, { kind: "observe" }>,
  content: string,
) {
  return {
    requestId: request.requestId,
    request,
    outcome: "observed" as const,
    observationRef: { id: `observation-${content}`, sha256: `sha-${content}` },
    content,
  };
}

function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const binding: PhaseRunBinding = {
    turnId: "turn-phase-persistence",
    turnRevision: 4,
    semanticState: "conception_deliberation",
    checkpointId: "checkpoint-phase-persistence",
    checkpointRevision: 1,
    claimId: "claim-phase-persistence",
    executionFence: 7,
  };
  db.query(`
    INSERT INTO btcc_checkpoints (
      checkpoint_id, turn_id, turn_revision, semantic_state,
      kind, checkpoint_revision, active_claim_id, is_active
    ) VALUES (?, ?, ?, ?, 'phase', ?, ?, 1)
  `).run(
    binding.checkpointId,
    binding.turnId,
    binding.turnRevision,
    binding.semanticState,
    binding.checkpointRevision,
    binding.claimId,
  );
  db.query(`
    INSERT INTO btcc_state_claims (
      claim_id, turn_id, turn_revision, semantic_state, checkpoint_id,
      checkpoint_revision, execution_fence, owner_id, owner_generation,
      lease_generation, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'owner-1', 1, 1, 'active')
  `).run(
    binding.claimId,
    binding.turnId,
    binding.turnRevision,
    binding.semanticState,
    binding.checkpointId,
    binding.checkpointRevision,
    binding.executionFence,
  );
  return { db, store: new SqlitePhaseConversationStore(db), binding };
}

function phaseEnvelope(binding: PhaseRunBinding): PhaseEnvelope {
  return {
    binding,
    phase: "conception_deliberation",
    operationSurface: "authorized",
    objective: "persist_exact_round",
    duties: [],
    prohibitions: [],
    modelSelection: selectedModel(),
    context: {
      originalMessageId: "message-1",
      originalMessage: "inspect and plan",
      sessionId: "session-1",
      userRef: "user-1",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: ["workspace:/repo"],
    },
    operationAuthority: {
      observationScopeRefs: ["workspace:/repo"],
      mutation: { kind: "forbidden" },
    },
    operationResults: [],
    submissionSchema: objectSchema({}),
  };
}

function observationRequest() {
  return {
    requestId: "request-1",
    kind: "observe" as const,
    capabilityRef: "read_file",
    scopeRef: "workspace:/repo",
    input: { path: "README.md" },
  };
}

function selectedModel() {
  return {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "low" as const,
    controls: { reasoningEffort: "low" },
    controlsHash: "controls-sha",
  };
}

function activePermit() {
  return {
    signal: new AbortController().signal,
    assertActive() {},
    close() {},
  };
}
