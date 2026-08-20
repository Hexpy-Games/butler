import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_PHASE_CONTINUITY_PRIVATE_DIGESTER } from
  "../support/phase-continuity-private-digester.ts";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { createProductionGuidedTurnAgent } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/index.ts";
import { selectGuidedTurnPhasePolicy } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-phase-policy.ts";
import {
  renderGuidedResponseLanguage,
  renderGuidedTurnRequestAttribution,
} from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-prompt.ts";
import {
  openAIBoundedConversationSerializedBytes,
  openAIInitialRequestSerializedBytes,
} from
  "../../packages/butler-agent/src/integrations/providers/openai/conversation-items.ts";
import {
  createTurnContinuationBudgetState,
  createTurnRuntime,
  transitionTurnContinuationBudget,
} from "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import type {
  BtccRunCommand,
  TurnContinuationBudgetEvent,
  TurnContinuationBudgetState,
  TurnRecord,
} from "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import type {
  ModelRoundRequest,
} from "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import type { ContextDocumentReader } from
  "../../packages/butler-agent/src/agent/context/context-projection.ts";
import { runOpenAIModelRound } from
  "../../packages/butler-agent/src/integrations/providers/openai/model-round.ts";

const limits = {
  maxModelRequests: 60,
  maxToolRounds: 60,
  maxModelFacingBytes: 192 * 1024,
  maxCumulativeModelFacingBytes: 8 * 1024 * 1024,
  maxOutputBytes: 512 * 1024,
  maxElapsedMs: 2 * 60 * 60 * 1_000,
  maxIdleMs: 20 * 60 * 1_000,
};

test("context document read returns verified typed metadata", () => {
  const fixture = createFixture("feature-memory-read");
  try {
    const ref = persist(fixture, "profile", "profile-source", "revision-1", "profile body");
    expect(fixture.stores.contextDocuments.read(ref)).toEqual({
      contextRef: ref,
      contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceId: "profile-source",
      projectionClass: "profile",
      scopeKind: "user",
      scopeId: "user",
      sourceRevision: "revision-1",
      content: "profile body",
    });

    const db = new Database(fixture.dbPath);
    db.query("UPDATE btcc_context_documents SET source_revision = ? WHERE context_ref = ?")
      .run("mutated-revision", ref);
    db.close(false);
    expect(() => fixture.stores.contextDocuments.read(ref)).toThrow(
      "btcc_context_document_identity_invalid",
    );
  } finally {
    fixture.close();
  }
});

test("production Guided Turn applies the fixed phase memory allowlist in typed order", async () => {
  const fixture = createFixture("feature-memory-phases");
  try {
    const refs = persistAll(fixture, 4_000);
    const direct = await runCaptured(fixture, turnRecord(fixture.root, "direct", refs));
    const readOnly = await runCaptured(fixture, turnRecord(fixture.root, "read_only", refs));
    const execution = await runCaptured(fixture, turnRecord(fixture.root, "execution", refs));

    expect(combined(direct)).toContain('"sourceId":"profile-a"');
    expect(combined(direct)).toContain('"sourceId":"profile-b"');
    expect(combined(direct)).toContain('"sourceId":"feedback"');
    expect(combined(direct)).not.toContain('"sourceId":"mandatory"');
    expect(combined(direct)).not.toContain('"sourceId":"optional"');
    expect(direct.instructions).toContain("Use Korean for every user-facing message");
    expect(direct.messages[0]?.content).toContain("Keep this exact current user request.");
    expect(combined(direct).indexOf('"sourceId":"profile-a"'))
      .toBeLessThan(combined(direct).indexOf('"sourceId":"profile-b"'));

    expect(combined(readOnly)).toContain('"sourceId":"profile-a"');
    expect(combined(readOnly)).toContain('"sourceId":"feedback"');
    expect(combined(readOnly)).toContain('"sourceId":"mandatory"');
    expect(combined(readOnly)).not.toContain('"sourceId":"optional"');

    // Execution excludes no class, so strict-shrink admission retains the exact legacy view.
    expect(combined(execution)).toContain("optional-body-");
    expect(combined(execution)).not.toContain('"sourceId":"optional"');
  } finally {
    fixture.close();
  }
});

test("default-off Guided Turn preserves the exact pre-v4 request body", async () => {
  const fixture = createFixture("feature-memory-default-off");
  try {
    const refs = persistAll(fixture, 4_000);
    const turn = turnRecord(fixture.root, "direct", refs);
    delete turn.continuationBudget;
    const policy = selectGuidedTurnPhasePolicy(turn, {});
    const expected = renderGuidedTurnRequestAttribution(
      turn,
      policy.stableInstructionPrefix,
      renderGuidedResponseLanguage(turn, fixture.stores.contextDocuments),
      {
        butlerData: fixture.root,
        contextDocuments: fixture.stores.contextDocuments,
        toolJournal: fixture.stores.guidedToolJournal,
        workContext: "",
        effectContext: "",
      },
    );
    let typedReads = 0;
    const request = await runCaptured(fixture, turn, {
      resolve: fixture.stores.contextDocuments.resolve.bind(
        fixture.stores.contextDocuments,
      ),
      read(contextRef) {
        typedReads += 1;
        return fixture.stores.contextDocuments.read(contextRef);
      },
    });
    expect(request.messages[0]?.content).toBe(expected.prompt);
    expect(request.instructions).toBe(expected.instructions);
    expect(combined(request)).toContain("optional-body-");
    expect(combined(request)).not.toContain('"sourceId":"profile-a"');
    expect(typedReads).toBe(0);
  } finally {
    fixture.close();
  }
});

test("phase memory projection is a strict-shrink no-op for a tiny excluded document", async () => {
  const fixture = createFixture("feature-memory-strict-noop");
  try {
    const refs = persistAll(fixture, 1);
    const request = await runCaptured(fixture, turnRecord(fixture.root, "direct", refs));
    expect(combined(request)).toContain("optional-body-x");
    expect(combined(request)).not.toContain('"sourceId":"profile-a"');
  } finally {
    fixture.close();
  }
});

test("phase memory projection is restart-stable and never exceeds its 12 KiB memory ceiling", async () => {
  const fixture = createFixture("feature-memory-restart");
  try {
    const refs = persistAll(fixture, 20_000);
    const first = await runCaptured(fixture, turnRecord(fixture.root, "read_only", refs));
    const second = await runCaptured(fixture, turnRecord(fixture.root, "read_only", refs));
    expect(second.messages[0]?.content).toBe(first.messages[0]?.content);
    expect(second.instructions).toBe(first.instructions);
    expect(Buffer.byteLength(first.messages[0]?.content ?? "", "utf8")).toBeLessThan(16 * 1024);
  } finally {
    fixture.close();
  }
});

test("malformed typed memory identity fails before the provider and is not downgraded", async () => {
  const fixture = createFixture("feature-memory-invalid");
  try {
    const refs = persistAll(fixture, 4_000);
    const db = new Database(fixture.dbPath);
    db.query("UPDATE btcc_context_documents SET projection_class = ? WHERE context_ref = ?")
      .run("optional_hot_cache", refs.profileRefs[0]);
    db.close(false);
    let providerCalls = 0;
    const agent = createProductionGuidedTurnAgent({
      phaseContinuityPrivateDigester: TEST_PHASE_CONTINUITY_PRIVATE_DIGESTER,
      butlerHome: fixture.root,
      butlerData: fixture.root,
      contextDocuments: fixture.stores.contextDocuments,
      toolJournal: fixture.stores.guidedToolJournal,
      effectJournal: fixture.stores.guidedEffectJournal,
      durableWork: fixture.stores.durableWork,
      modelRound: {
        initialRequestBytes: openAIInitialRequestSerializedBytes,
        statelessMessageBytes: openAIBoundedConversationSerializedBytes,
        async runRound() {
          providerCalls += 1;
          return { text: "must not run", toolCalls: [] };
        },
      },
    });
    await expect(agent.run({
      turn: turnRecord(fixture.root, "direct", refs),
      signal: new AbortController().signal,
      transitionContinuationBudget: budgetTransition(),
    })).rejects.toMatchObject({
      name: "PhaseScopedMemoryProjectionError",
      code: "phase_scoped_memory_document_invalid",
    });
    expect(providerCalls).toBe(0);
  } finally {
    fixture.close();
  }
});

test("phase memory projection requires the production serializer before dispatch", async () => {
  const fixture = createFixture("feature-memory-dependency");
  try {
    const refs = persistAll(fixture, 4_000);
    let providerCalls = 0;
    const agent = createProductionGuidedTurnAgent({
      phaseContinuityPrivateDigester: TEST_PHASE_CONTINUITY_PRIVATE_DIGESTER,
      butlerHome: fixture.root,
      butlerData: fixture.root,
      contextDocuments: fixture.stores.contextDocuments,
      toolJournal: fixture.stores.guidedToolJournal,
      effectJournal: fixture.stores.guidedEffectJournal,
      durableWork: fixture.stores.durableWork,
      modelRound: {
        async runRound() {
          providerCalls += 1;
          return { text: "must not run", toolCalls: [] };
        },
      },
    });
    await expect(agent.run({
      turn: turnRecord(fixture.root, "direct", refs),
      signal: new AbortController().signal,
      transitionContinuationBudget: budgetTransition(),
    })).rejects.toMatchObject({
      name: "PhaseScopedMemoryProjectionError",
      code: "phase_scoped_memory_dependency_missing",
    });
    expect(providerCalls).toBe(0);
  } finally {
    fixture.close();
  }
});

test("phase memory projection fails when mandatory typed identities exceed 12 KiB", async () => {
  const fixture = createFixture("feature-memory-overflow");
  try {
    const profileRefs = Array.from({ length: 90 }, (_, index) => persist(
      fixture,
      "profile",
      `profile-${index}-${"s".repeat(120)}`,
      `revision-${index}-${"r".repeat(120)}`,
      "required profile fact",
    ));
    const optionalRef = persist(
      fixture, "optional_hot_cache", "optional", "revision-optional", "excluded",
    );
    const refs: ContextRefs = {
      profileRefs,
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [optionalRef],
    };
    await expect(runCaptured(
      fixture,
      turnRecord(fixture.root, "direct", refs),
    )).rejects.toMatchObject({
      name: "PhaseScopedMemoryProjectionError",
      code: "phase_scoped_memory_projection_too_large",
    });
  } finally {
    fixture.close();
  }
});

test("SQLite reopen preserves typed reads and exact projected request bytes", async () => {
  const fixture = createFixture("feature-memory-reopen");
  let reopened: ReturnType<typeof openBtccSqliteStores> | undefined;
  let firstClosed = false;
  try {
    const refs = persistAll(fixture, 4_000);
    const turn = turnRecord(fixture.root, "read_only", refs);
    const firstRead = fixture.stores.contextDocuments.read(refs.profileRefs[0]!);
    const first = await runCaptured(fixture, turn);
    fixture.stores.close();
    firstClosed = true;

    reopened = openBtccSqliteStores({
      dbPath: fixture.dbPath,
      ownerId: "feature-memory-reopen-second",
      storageProfile: "ephemeral",
    });
    const secondFixture = { ...fixture, stores: reopened };
    const secondRead = reopened.contextDocuments.read(refs.profileRefs[0]!);
    const second = await runCaptured(secondFixture, turn);
    expect(secondRead).toEqual(firstRead);
    expect(second.messages[0]?.content).toBe(first.messages[0]?.content);
    expect(second.instructions).toBe(first.instructions);
    expect(openAIInitialRequestSerializedBytes({
      prompt: second.messages[0]!.content,
      instructions: second.instructions ?? "",
    })).toBe(openAIInitialRequestSerializedBytes({
      prompt: first.messages[0]!.content,
      instructions: first.instructions ?? "",
    }));
  } finally {
    reopened?.close();
    if (!firstClosed) fixture.stores.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("actual Turn runtime preserves every typed memory projection failure", async () => {
  const previous = process.env.BUTLER_BOUNDED_STATELESS_CONTEXT;
  process.env.BUTLER_BOUNDED_STATELESS_CONTEXT = "on";
  const cases = [
    "phase_scoped_memory_dependency_missing",
    "phase_scoped_memory_document_invalid",
    "phase_scoped_memory_projection_too_large",
    "phase_scoped_memory_serializer_failed",
  ] as const;
  try {
    for (const code of cases) {
      const fixture = createFixture(`feature-memory-runtime-${code}`);
      try {
        const configured = configureRuntimeFailure(fixture, code);
        let providerCalls = 0;
        const agent = createProductionGuidedTurnAgent({
          phaseContinuityPrivateDigester: TEST_PHASE_CONTINUITY_PRIVATE_DIGESTER,
          butlerHome: fixture.root,
          butlerData: fixture.root,
          contextDocuments: configured.contextDocuments,
          toolJournal: fixture.stores.guidedToolJournal,
          effectJournal: fixture.stores.guidedEffectJournal,
          durableWork: fixture.stores.durableWork,
          modelRound: {
            initialRequestBytes: configured.initialRequestBytes,
            statelessMessageBytes: openAIBoundedConversationSerializedBytes,
            async runRound() {
              providerCalls += 1;
              return { text: "must not run", toolCalls: [] };
            },
          },
        });
        const runtime = createTurnRuntime({
          admission: fixture.stores.admission,
          turns: fixture.stores.turns,
          messages: fixture.stores.messages,
          committedSuccessorReadiness: fixture.stores.committedSuccessorReadiness,
          agent,
        });
        const command = runtimeCommand(fixture.root, code, configured.refs);
        await expect(runtime.runTurn(command)).rejects.toMatchObject({
          name: "PhaseScopedMemoryProjectionError",
          code,
        });
        expect(providerCalls).toBe(0);
        const persisted = await fixture.stores.turns.findTurn(command.turnId);
        expect(persisted?.semanticState).toBe("admitted");
        expect(persisted?.finalPayload).toBeUndefined();
        const db = new Database(fixture.dbPath, { readonly: true });
        try {
          expect(db.query<{ count: number }, [string]>(`
            SELECT COUNT(*) AS count FROM btcc_messages
            WHERE turn_id = ? AND role = 'assistant'
          `).get(command.turnId)?.count).toBe(0);
        } finally {
          db.close(false);
        }
      } finally {
        fixture.close();
      }
    }
  } finally {
    restoreEnv("BUTLER_BOUNDED_STATELESS_CONTEXT", previous);
  }
}, 30_000);

for (const transport of ["official", "codex"] as const) {
  test(`${transport} final request body admits only a strict memory shrink`, async () => {
    const fixture = createFixture(`feature-memory-final-${transport}`);
    const tinyFixture = createFixture(`feature-memory-final-tiny-${transport}`);
    const originalFetch = globalThis.fetch;
    const priorOfficial = process.env.OPENAI_BASE_URL;
    const priorCodex = process.env.BUTLER_CODEX_RESPONSES_URL;
    process.env.OPENAI_BASE_URL = "https://example.test/v1";
    process.env.BUTLER_CODEX_RESPONSES_URL = "https://example.test/codex";
    const bodies: string[] = [];
    let responseIndex = 0;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      const response = {
        id: `phase-memory-${responseIndex++}`,
        model: "gpt-5.6-sol",
        output: [],
      };
      return transport === "official"
        ? Response.json(response)
        : new Response(
            `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
    }) as typeof fetch;
    try {
      const largeRefs = persistAll(fixture, 4_000);
      const largeTurn = turnRecord(fixture.root, "direct", largeRefs);
      const projectedLarge = await runCaptured(fixture, largeTurn);
      const exactLarge = exactRequest(fixture, largeTurn, projectedLarge);
      const tinyRefs = persistAll(tinyFixture, 1);
      const tinyTurn = turnRecord(tinyFixture.root, "direct", tinyRefs);
      const projectedTiny = await runCaptured(tinyFixture, tinyTurn);
      const exactTiny = exactRequest(tinyFixture, tinyTurn, projectedTiny);
      const auth = transport === "official"
        ? { mode: "api_key" as const, authorization: "Bearer test" }
        : {
            mode: "codex_subscription" as const,
            authorization: `Bearer ${fakeJwt()}`,
          };
      for (const request of [exactLarge, projectedLarge, exactTiny, projectedTiny]) {
        await runOpenAIModelRound(requestForFinalSerializer(request), auth);
      }
      expect(bodies).toHaveLength(4);
      expect(Buffer.byteLength(bodies[1]!, "utf8"))
        .toBeLessThan(Buffer.byteLength(bodies[0]!, "utf8"));
      expect(Buffer.from(bodies[3]!)).toEqual(Buffer.from(bodies[2]!));
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("OPENAI_BASE_URL", priorOfficial);
      restoreEnv("BUTLER_CODEX_RESPONSES_URL", priorCodex);
      tinyFixture.close();
      fixture.close();
    }
  }, 30_000);
}

function createFixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `${label}-`));
  const stores = openBtccSqliteStores({
    dbPath: join(root, "btcc.sqlite"), ownerId: label, storageProfile: "ephemeral",
  });
  const dbPath = join(root, "btcc.sqlite");
  return { root, dbPath, stores, close() { stores.close(); rmSync(root, { recursive: true, force: true }); } };
}

type Fixture = ReturnType<typeof createFixture>;
type ContextRefs = Pick<TurnRecord["context"],
  "profileRefs" | "recentFeedbackRefs" | "mandatoryHotCacheRefs" | "optionalHotCacheRefs">;

function persist(
  fixture: Fixture,
  projectionClass: "profile" | "recent_feedback" | "mandatory_hot_cache" | "optional_hot_cache",
  sourceId: string,
  sourceRevision: string,
  content: string,
): string {
  return fixture.stores.contextDocuments.persist({
    scopeKind: projectionClass === "profile" ? "user" : "session",
    scopeId: projectionClass === "profile" ? "user" : "session",
    projectionClass, sourceId, sourceRevision, content,
  });
}

function persistAll(fixture: Fixture, repeated: number): ContextRefs {
  const body = "x".repeat(repeated);
  return {
    profileRefs: [
      persist(fixture, "profile", "profile-a", "revision-profile-a", `profile-a-body-${body}`),
      persist(fixture, "profile", "profile-b", "revision-profile-b", `profile-b-body-${body}`),
    ],
    recentFeedbackRefs: [
      persist(fixture, "recent_feedback", "feedback", "revision-feedback", `feedback-body-${body}`),
    ],
    mandatoryHotCacheRefs: [
      persist(fixture, "mandatory_hot_cache", "mandatory", "revision-mandatory", `mandatory-body-${body}`),
    ],
    optionalHotCacheRefs: [
      persist(
        fixture,
        "optional_hot_cache",
        "optional",
        "revision-optional",
        `Assistant Response Language: Korean\noptional-body-${body}`,
      ),
    ],
  };
}

function turnRecord(
  workspacePath: string,
  phase: "direct" | "read_only" | "execution",
  refs: ContextRefs,
): TurnRecord {
  const turnId = `turn-${phase}`;
  return {
    turnId, sessionId: `session-${phase}`, inboxId: `inbox-${phase}`,
    triggerKey: `trigger-${phase}`, originalMessageId: `message-${phase}`,
    originalMessage: "Keep this exact current user request.",
    modelSelection: {
      provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "medium",
      controls: { accessMode: phase === "execution" ? "full_access" : "read_only" },
      controlsHash: "controls",
    },
    context: {
      userRef: "user", ...(phase === "direct" ? {} : { projectRef: "project" }),
      ...refs, baselineObservationScopeRefs: [`workspace:${workspacePath}`],
      executionPolicy: {
        role: "butler",
        accessMode: phase === "execution" ? "full_access" : "read_only",
        trackingMode: "none", requiredNativeToolProfiles: [], requiredNativeTools: [],
        workspacePath, ...(phase === "direct" ? {} : { projectId: "project" }),
      },
    },
    semanticState: "admitted",
    checkpoint: {
      checkpointId: `checkpoint-${phase}`, checkpointRevision: 1,
      kind: "runtime", semanticState: "admitted",
    },
    continuationBudget: createTurnContinuationBudgetState({ turnId, limits, nowMs: 1 }),
    revision: 0, executionFence: 0,
  };
}

async function runCaptured(
  fixture: Fixture,
  turn: TurnRecord,
  contextDocuments: ContextDocumentReader = fixture.stores.contextDocuments,
): Promise<ModelRoundRequest> {
  let request: ModelRoundRequest | undefined;
  const agent = createProductionGuidedTurnAgent({
    phaseContinuityPrivateDigester: TEST_PHASE_CONTINUITY_PRIVATE_DIGESTER,
    butlerHome: fixture.root,
    butlerData: fixture.root,
    contextDocuments,
    toolJournal: fixture.stores.guidedToolJournal,
    effectJournal: fixture.stores.guidedEffectJournal,
    durableWork: fixture.stores.durableWork,
    modelRound: {
      initialRequestBytes: openAIInitialRequestSerializedBytes,
      statelessMessageBytes: openAIBoundedConversationSerializedBytes,
      async runRound(value) { request = value; return { text: "done", toolCalls: [] }; },
    },
  });
  await agent.run({
    turn, signal: new AbortController().signal,
    transitionContinuationBudget: budgetTransition(),
  });
  if (!request) throw new Error("request_not_captured");
  return request;
}

function budgetTransition() {
  let state: TurnContinuationBudgetState | undefined;
  return async (event: TurnContinuationBudgetEvent): Promise<TurnContinuationBudgetState> => {
    if (!state) {
      const turnId = event.kind === "admit_request"
        ? event.roundId.replace(/^btcc-model-round-/u, "turn-")
        : "turn";
      state = createTurnContinuationBudgetState({ turnId, limits, nowMs: 1 });
    }
    state = transitionTurnContinuationBudget(state, event, state.lastProgressAtMs + 1);
    return state;
  };
}

function combined(request: ModelRoundRequest): string {
  return `${request.instructions ?? ""}\n${request.messages.map((message) => message.content).join("\n")}`;
}

function configureRuntimeFailure(
  fixture: Fixture,
  code:
    | "phase_scoped_memory_dependency_missing"
    | "phase_scoped_memory_document_invalid"
    | "phase_scoped_memory_projection_too_large"
    | "phase_scoped_memory_serializer_failed",
): {
  refs: ContextRefs;
  contextDocuments: ContextDocumentReader;
  initialRequestBytes: typeof openAIInitialRequestSerializedBytes;
} {
  let refs = persistAll(fixture, 4_000);
  let contextDocuments: ContextDocumentReader = fixture.stores.contextDocuments;
  let initialRequestBytes = openAIInitialRequestSerializedBytes;
  if (code === "phase_scoped_memory_dependency_missing") {
    contextDocuments = {
      resolve: fixture.stores.contextDocuments.resolve.bind(
        fixture.stores.contextDocuments,
      ),
    } as ContextDocumentReader;
  } else if (code === "phase_scoped_memory_document_invalid") {
    const db = new Database(fixture.dbPath);
    db.query("UPDATE btcc_context_documents SET source_revision = ? WHERE context_ref = ?")
      .run("mutated", refs.profileRefs[0]);
    db.close(false);
  } else if (code === "phase_scoped_memory_projection_too_large") {
    refs = {
      profileRefs: Array.from({ length: 90 }, (_, index) => persist(
        fixture,
        "profile",
        `runtime-profile-${index}-${"s".repeat(120)}`,
        `runtime-revision-${index}-${"r".repeat(120)}`,
        "required profile fact",
      )),
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [persist(
        fixture,
        "optional_hot_cache",
        "runtime-optional",
        "runtime-optional-revision",
        "excluded",
      )],
    };
  } else {
    initialRequestBytes = () => {
      throw new Error("invalid_initial_request_serializer");
    };
  }
  return { refs, contextDocuments, initialRequestBytes };
}

function runtimeCommand(
  workspacePath: string,
  suffix: string,
  refs: ContextRefs,
): Extract<BtccRunCommand, { kind: "run" }> {
  return {
    kind: "run",
    turnId: `runtime-${suffix}`,
    sessionId: `runtime-session-${suffix}`,
    triggerKey: `runtime-trigger-${suffix}`,
    message: {
      messageId: `runtime-message-${suffix}`,
      content: "Keep this exact current runtime request.",
    },
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      controls: { accessMode: "read_only" },
      controlsHash: "controls",
    },
    context: {
      userRef: "user",
      ...refs,
      baselineObservationScopeRefs: [`workspace:${workspacePath}`],
      executionPolicy: {
        role: "butler",
        accessMode: "read_only",
        trackingMode: "none",
        requiredNativeToolProfiles: [],
        requiredNativeTools: [],
        workspacePath,
      },
    },
  };
}

function exactRequest(
  fixture: Fixture,
  turn: TurnRecord,
  projected: ModelRoundRequest,
): ModelRoundRequest {
  const policy = selectGuidedTurnPhasePolicy(turn, {});
  const exact = renderGuidedTurnRequestAttribution(
    turn,
    policy.stableInstructionPrefix,
    renderGuidedResponseLanguage(turn, fixture.stores.contextDocuments),
    {
      butlerData: fixture.root,
      contextDocuments: fixture.stores.contextDocuments,
      toolJournal: fixture.stores.guidedToolJournal,
      workContext: "",
      effectContext: "",
    },
  );
  return {
    ...projected,
    messages: projected.messages.map((message, index) =>
      index === 0 ? { ...message, content: exact.prompt } : message),
    instructions: exact.instructions,
  };
}

function requestForFinalSerializer(request: ModelRoundRequest): ModelRoundRequest {
  return {
    ...request,
    usageAttribution: undefined,
    ...(request.boundedContinuation
      ? {
          boundedContinuation: {
            ...request.boundedContinuation,
            admitProviderBody: async () => {},
          },
        }
      : {}),
  };
}

function fakeJwt(): string {
  return `header.${Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "account-test" },
  })).toString("base64url")}.signature`;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
