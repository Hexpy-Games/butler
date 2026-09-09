import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DURABLE_WORK_TOOL_DEFINITIONS,
  executeDurableWorkTool,
  renderDurableWorkContext,
} from "../../packages/butler-agent/src/agent/btcc/agent-loop/durable-work-tools.ts";
import { projectDurableWorkToolSurface } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/durable-work-tool-surface.ts";
import {
  createDurableWorkService,
  type DurableWorkService,
  type DurableWorkExecutionMode,
} from "../../packages/butler-agent/src/agent/btcc/work/index.ts";
import {
  SqliteGuidedWorkStore,
} from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { migrateBtccSchema } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema/migrate-schema.ts";
import { SqlitePrincipalAuthorityRepository } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/authority-repository.ts";
import { SqliteGuidedToolJournal } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/guided-tool-journal.ts";
import { createPrincipalAuthority } from
  "../../packages/butler-agent/src/agent/btcc/authority/index.ts";
import { createGuidedToolExecutionBoundary } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-tool-execution-boundary.ts";
import {
  createGuidedWorkspaceFileEffectAdapter,
  workspaceFileEffectTarget,
} from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-workspace-file-effect.ts";
import { writeFileToolDefinition } from
  "../../packages/butler-agent/src/agent/tools/file-tools/write_file/definition.ts";
import { GuidedEffectTestFixture, reviewedWork } from
  "./support/guided-effect-test-fixture.ts";
import {
  canonicalProjectWorkChildBody,
  decodeChild,
  type ProjectWorkChild,
} from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/project-work-child-codec.ts";

test("reviewed Plan execution ownership is a required stable model contract", async () => {
  const replace = DURABLE_WORK_TOOL_DEFINITIONS.find((tool) =>
    tool.name === "replace_work_plan");
  const parameters = replace?.parameters as {
    required: string[];
    properties: { execution_mode: { enum: string[] } };
  };
  expect(parameters.required).toContain("execution_mode");
  expect(parameters.properties.execution_mode.enum).toEqual(["direct", "steward", "workers"]);

  const stable = JSON.stringify(DURABLE_WORK_TOOL_DEFINITIONS);
  const projected = projectDurableWorkToolSurface(
    DURABLE_WORK_TOOL_DEFINITIONS,
    undefined,
  );
  expect(projected.map((tool) => tool.name)).toEqual(
    DURABLE_WORK_TOOL_DEFINITIONS.map((tool) => tool.name),
  );
  expect(JSON.stringify(projected)).toBe(stable);

  let receivedMode: string | undefined;
  const service = {
    replacePlan(input: Parameters<DurableWorkService["replacePlan"]>[0]) {
      receivedMode = input.executionMode;
      return Promise.resolve(workView("workers"));
    },
    loadContext: async () => null,
  } as unknown as DurableWorkService;
  const result = await executeDurableWorkTool({
    service,
    scope: { turnId: "turn-mode", sessionId: "session-mode" },
    mutationCallId: "call-mode",
    name: "replace_work_plan",
    args: {
      objective: "Execute the reviewed Plan",
      execution_mode: "workers",
      actions: [{ action_key: "implement" }],
    },
  });
  expect(receivedMode).toBe("workers");
  expect(result).toMatchObject({
    ok: true,
    work: { execution_mode: "workers" },
  });
});

test.each(["direct", "steward", "workers"] as const)("Session and Project Plan persistence round-trip %s ownership without rewriting legacy Plans", async (mode) => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const service = createDurableWorkService(new SqliteGuidedWorkStore(
    db,
    createPrincipalAuthority(new SqlitePrincipalAuthorityRepository(db)),
  ));
  try {
    db.query(`
      INSERT INTO btcc_turns (
        turn_id, session_id, inbox_id, trigger_key, original_message_id,
        original_message, admission_snapshot_ref, model_selection_json,
        context_json, semantic_state, revision, execution_fence
      ) VALUES (?, ?, ?, ?, ?, ?, 'snapshot', '{}', '{}', 'admitted', 1, 0)
    `).run(
      "turn-persist-mode",
      "session-persist-mode",
      "inbox-persist-mode",
      "trigger-persist-mode",
      "message-persist-mode",
      "Execute through Workers",
    );
    const scope = {
      turnId: "turn-persist-mode",
      sessionId: "session-persist-mode",
    };
    const planned = await service.replacePlan({
      ...scope,
      mutationCallId: "plan-persist-mode",
      objective: "Execute through Workers",
      executionMode: mode,
      actions: [{
        actionKey: "implement",
        description: "Implement the bounded slice",
        dependencyKeys: [],
      }],
      checks: ["Focused behavior passes"],
    });
    expect(planned.currentPlan?.executionMode).toBe(mode);
    expect((await service.loadContext(scope))?.work.currentPlan?.executionMode)
      .toBe(mode);
    expect(renderDurableWorkContext(await service.loadContext(scope)))
      .toContain(`Plan execution ownership: ${mode}`);
  } finally {
    db.close();
  }

  const current = projectPlanChild(mode);
  const decoded = decodeChild(
    canonicalProjectWorkChildBody(current),
    {
      schema: current.schema,
      workId: current.workId,
      recordId: current.plan.planRevisionId,
    },
  );
  expect(decoded.plan.executionMode).toBe(mode);

  const legacy = projectPlanChild(undefined);
  const decodedLegacy = decodeChild(
    canonicalProjectWorkChildBody(legacy),
    {
      schema: legacy.schema,
      workId: legacy.workId,
      recordId: legacy.plan.planRevisionId,
    },
  );
  expect(decodedLegacy.plan.executionMode).toBeUndefined();
});

test("existing Plan rows survive the execution ownership schema upgrade unchanged", () => {
  const db = new Database(":memory:");
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA.replace("('direct', 'steward', 'workers')", "('direct', 'workers')"));
    db.query("INSERT INTO btcc_guided_work_plan_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("old-plan", "old-work", 1, "Saved objective", "[]", "direct", "[]", "[]", "old-turn", "2026-09-05T00:00:00Z");
    const before = db.query("SELECT * FROM btcc_guided_work_plan_revisions").all();
    migrateBtccSchema(db);
    expect(db.query("SELECT * FROM btcc_guided_work_plan_revisions").all()).toEqual(before);
    db.query("INSERT INTO btcc_guided_work_plan_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("new-plan", "old-work", 2, "Saved objective", "[]", "steward", "[]", "[]", "new-turn", "2026-09-06T00:00:00Z");
    migrateBtccSchema(db);
    expect(db.query("SELECT execution_mode FROM btcc_guided_work_plan_revisions ORDER BY revision").all())
      .toEqual([{ execution_mode: "direct" }, { execution_mode: "steward" }]);
  } finally { db.close(); }
});

test("accepted Plan file effects approve exact occurrences and request a new approval for the next file", async () => {
  const fixture = new GuidedEffectTestFixture();
  const workspace = mkdtempSync(join(tmpdir(), "butler-reviewed-effect-"));
  let writeDispatches = 0;
  const authority = createPrincipalAuthority(
    new SqlitePrincipalAuthorityRepository(fixture.db),
  );
  const toolJournal = new SqliteGuidedToolJournal(fixture.db);
  const work = reviewedWork({
    actions: [{
      actionKey: "implement-deliverables",
      description: "Implement the reviewed deliverables",
      dependencyKeys: [],
      effect: {
        capability: "workspace mutation",
        target: "workspace deliverables",
      },
    }],
  });
  const adapter = createGuidedWorkspaceFileEffectAdapter({
    workspacePath: workspace,
    async executeWriteFile(input) {
      writeDispatches += 1;
      const path = join(workspace, input.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, input.content);
      return { ok: true };
    },
  });
  fixture.db.query(`
    INSERT INTO btcc_guided_works (
      work_id, session_id, scope_kind, scope_ref, origin_turn_id,
      origin_message_id, objective, status, created_at, updated_at
    ) VALUES (?, ?, 'session', ?, ?, ?, ?, 'open', ?, ?)
  `).run(
    work.workId,
    work.sessionId,
    work.sessionId,
    work.origin.turnId,
    work.origin.messageId,
    work.objective,
    work.createdAt,
    work.updatedAt,
  );

  const boundary = (turnId: string, continuation?: {
    requestRef: string;
    clientMessageId: string;
  }) => createGuidedToolExecutionBoundary({
    durableWork: {
      boundWorkForTurn: async () => work,
    } as unknown as DurableWorkService,
    workScope: { turnId, sessionId: work.sessionId },
    effectService: fixture.service(),
    authority,
    toolJournal,
    ownerSessionId: "owner-session",
    sourceSessionId: work.sessionId,
    sourceTurnId: turnId,
    modelRef: "openai/gpt-5.5",
    reasoningEffort: "high",
    workspacePath: workspace,
    ...(continuation
      ? {
          authorityRequestRef: continuation.requestRef,
          authorityClientMessageId: continuation.clientMessageId,
        }
      : {}),
    accessMode: "ask_first",
    signal: new AbortController().signal,
    executeCommand: async () => ({ ok: true }),
    resolvePersistentEffect: async (call) => {
      const normalizedInput = adapter.normalizeInput(call.args);
      return {
        target: workspaceFileEffectTarget(normalizedInput.path),
        input: normalizedInput,
        adapter,
      };
    },
  });
  const call = (
    executeBoundary: ReturnType<typeof boundary>,
    name: string,
    path: string,
    content: string,
    occurrenceId: string,
  ) => executeBoundary({
    call: {
      name,
      args: { path, content, create_parents: false },
      rawArguments: JSON.stringify({ path, content, create_parents: false }),
    },
    context: { effectOccurrenceId: occurrenceId },
    definition: writeFileToolDefinition,
    execute: async () => ({ ok: true }),
  });

  try {
    const requestBoundary = boundary("turn-request");
    const requestedArgs = { path: "first.md", content: "first", create_parents: false };
    toolJournal.start({ turnId: "turn-request", callId: "tool-call-first", toolName: "write_file", arguments: requestedArgs, rawArguments: JSON.stringify(requestedArgs) });
    const pending = await call(
      requestBoundary,
      "write_file",
      "first.md",
      "first",
      "tool-call-first",
    );
    toolJournal.finish({ callId: "tool-call-first", status: "completed", result: pending });
    expect(pending).toMatchObject({ status: "awaiting_allow" });
    const [firstRequest] = authority.list({ ownerSessionId: "owner-session" });
    expect(firstRequest).toMatchObject({
      category: "reviewed_effect",
      executable: "write_file",
    });
    const allowed = authority.decide({
      ownerSessionId: "owner-session",
      sourceSessionId: work.sessionId,
      requestRef: firstRequest!.request_ref,
      action: "allow",
    });

    const continuation = boundary("turn-scheduled", {
      requestRef: allowed.requestRef,
      clientMessageId: allowed.scheduleClientMessageId,
    });
    expect(await call(
      continuation,
      "edit_file",
      "wrong.md",
      "wrong",
      "tool-call-wrong",
    )).toMatchObject({
      ok: false,
      error: { code: "authority_request_identity_mismatch" },
    });
    expect(await call(
      continuation,
      "write_file",
      "ignored-by-stored-input.md",
      "ignored",
      "tool-call-retry",
    )).toMatchObject({ effect_receipt: { replayed: false } });
    expect(writeDispatches).toBe(1);

    expect(await call(
      continuation,
      "write_file",
      "second.md",
      "second",
      "tool-call-second",
    )).toMatchObject({ status: "awaiting_allow" });
    expect(writeDispatches).toBe(1);
    const [secondRequest] = authority.list({ ownerSessionId: "owner-session" });
    expect(secondRequest?.request_ref).not.toBe(firstRequest?.request_ref);
    const stored = fixture.db.query<{
      authority_generation: number;
      normalized_input_json: string;
    }, []>(`
      SELECT authority_generation, normalized_input_json
      FROM btcc_authority_requests ORDER BY authority_generation
    `).all();
    expect(stored.map((row) => row.authority_generation)).toEqual([1, 2]);
    expect(JSON.parse(stored[1]!.normalized_input_json)).toEqual({
      path: "second.md",
      content: "second",
      create_parents: false,
    });
  } finally {
    fixture.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

function workView(executionMode: DurableWorkExecutionMode) {
  return {
    workId: "work-mode",
    sessionId: "session-mode",
    scope: { kind: "session" as const, sessionId: "session-mode" },
    origin: { turnId: "turn-mode", messageId: "message-mode" },
    objective: "Execute the reviewed Plan",
    status: "open" as const,
    currentStage: "planning" as const,
    allowedNextStages: ["review" as const],
    actionProgress: [{ actionKey: "implement", status: "pending" as const }],
    currentPlan: {
      planRevisionId: "plan-mode",
      revision: 1,
      objective: "Execute the reviewed Plan",
      executionMode,
      actions: [{
        actionKey: "implement",
        description: "Implement",
        dependencyKeys: [],
      }],
      checks: [],
      originTurnId: "turn-mode",
      createdAt: "2026-09-05T00:00:00.000Z",
    },
    resultRefs: [],
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
  };
}

function projectPlanChild(
  executionMode: DurableWorkExecutionMode | undefined,
): Extract<ProjectWorkChild, { schema: "butler.btcc-project-work-plan.v1" }> {
  return {
    schema: "butler.btcc-project-work-plan.v1",
    workId: "work-project-mode",
    operationIdentity: {
      kind: "mutation_call",
      id: "mutation-project-mode",
      mutationCallId: "mutation-project-mode",
      requestSha256: "0".repeat(64),
    },
    plan: {
      planRevisionId: "plan-project-mode",
      revision: 1,
      objective: "Execute the Project Plan",
      ...(executionMode ? { executionMode } : {}),
      actions: [{
        actionKey: "implement",
        description: "Implement",
        dependencyKeys: [],
      }],
      checks: [],
      originTurnId: "turn-project-mode",
      createdAt: "2026-09-05T00:00:00.000Z",
    },
  };
}
