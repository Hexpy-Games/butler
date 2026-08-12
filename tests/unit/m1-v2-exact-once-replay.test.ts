import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/index.ts";
import { createOperationResultReplay, exactReadArguments } from
  "../../packages/butler-agent/src/agent/btcc/operation-result-replay/index.ts";
import { codexRequestBody } from
  "../../packages/butler-agent/src/integrations/providers/openai/responses-client.ts";
import { runBtccAgentLoop } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/agent-loop.ts";
import { buildModelRoute, createModelRoutePort } from
  "../../packages/butler-agent/src/agent/btcc/model-route/index.ts";
import { ModelProviderRequestError } from
  "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import type { GuidedOperationResultReader, GuidedToolJournal } from
  "../../packages/butler-agent/src/agent/btcc/ports/index.ts";

function routeAccepted(roundId: string, text: string) {
  return {
    text, toolCalls: [],
    acceptedCheckpoint: {
      roundId, candidateIndex: 0, transportAttempt: 1, modelRef: "openai/gpt-5.6-sol",
    },
  };
}

function exactPage(
  result_ref: string,
  sha256: string,
  revision: number | null,
  work_id: string | null = null,
) {
  return { result_ref, sha256, revision, work_id, offset: 0, length: 32 };
}

test("enabled replay fails composition when its exact journal dependency is incomplete", () => {
  expect(() => createOperationResultReplay({
    turnId: "turn", turnRevision: 1, exactReadCapability: true,
    journal: {} as GuidedToolJournal,
    exactReader: {} as GuidedOperationResultReader,
  })).toThrow("operation_result_replay_dependency_missing");
});

test("accepted durable large result is raw once then a bounded reference in the actual Codex serializer", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-exact-replay-"));
  const stores = openBtccSqliteStores({ dbPath: join(root, "btcc.sqlite"), ownerId: "test" });
  try {
    const large = { ok: true, content: "L".repeat(24_000) };
    stores.guidedToolJournal.start({ turnId: "turn", callId: "large", toolName: "read_file", rawArguments: "{}", arguments: {} });
    stores.guidedToolJournal.finish({ callId: "large", status: "completed", result: large });
    const replay = createOperationResultReplay({ turnId: "turn", turnRevision: 7, journal: stores.guidedToolJournal, exactReader: stores.guidedOperationResultReader, exactReadCapability: true });
    const raw = JSON.stringify({ ok: true, output: large });
    const messages = [{ role: "tool" as const, toolCallId: "large", name: "read_file", content: raw }];
    expect(replay.prepareMessages(messages, "round-2")[0]!.content).toBe(raw);
    replay.accepted("round-2", routeAccepted("round-2", "continue"));
    const reference = replay.prepareMessages(messages, "round-3")[0]!.content;
    const baseline = codexRequestBody({ model: "gpt-5.6-sol", input: [], __butler_codex_stateless_input: [
      { type: "function_call_output", call_id: "large", output: raw },
      { type: "function_call_output", call_id: "large", output: raw },
    ] });
    const after = codexRequestBody({ model: "gpt-5.6-sol", input: [], __butler_codex_stateless_input: [
      { type: "function_call_output", call_id: "large", output: raw },
      { type: "function_call_output", call_id: "large", output: reference },
    ] });
    const baselineBytes = Buffer.byteLength(JSON.stringify(baseline));
    const afterBytes = Buffer.byteLength(JSON.stringify(after));
    const outputs = (after.input as Array<{ output?: string }>).map((item) => item.output ?? "");
    expect(outputs.filter((output) => output.includes("L".repeat(1024)))).toHaveLength(1);
    expect(JSON.stringify(after)).toContain("butler.operation-result-reference.v1");
    expect(afterBytes).toBeLessThan(baselineBytes);
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retry redelivers raw without duplicate authority and 100 later rounds stay bounded", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-exact-replay-retry-"));
  const stores = openBtccSqliteStores({ dbPath: join(root, "btcc.sqlite"), ownerId: "retry" });
  try {
    const result = { ok: true, content: "X".repeat(18_000), private_path: "/not-projected/path" };
    stores.guidedToolJournal.start({ turnId: "turn", callId: "call", toolName: "read_file", rawArguments: "{private}", arguments: {} });
    stores.guidedToolJournal.finish({ callId: "call", status: "completed", result });
    const replay = createOperationResultReplay({ turnId: "turn", turnRevision: 1, journal: stores.guidedToolJournal, exactReader: stores.guidedOperationResultReader, exactReadCapability: true });
    const messages = [{ role: "tool" as const, toolCallId: "call", name: "read_file", content: JSON.stringify(result) }];
    expect(replay.prepareMessages(messages, "round")[0]!.content).toContain("X".repeat(1024));
    replay.failed("round");
    expect(replay.prepareMessages(messages, "round")[0]!.content).toContain("X".repeat(1024));
    replay.accepted("round", routeAccepted("round", "accepted"));
    const projections = Array.from({ length: 100 }, (_, index) =>
      replay.prepareMessages(messages, `later-${index}`)[0]!.content,
    );
    expect(new Set(projections).size).toBe(1);
    expect(Buffer.byteLength(projections[0]!)).toBeLessThan(1024);
    expect(projections[0]).not.toContain("private_path");
    expect(projections[0]).not.toContain("/not-projected/path");
    expect(JSON.parse(projections[0]!).outcome).toEqual({
      status: "completed", success: true, verification: "stored_exact_available",
    });
    expect(stores.guidedToolJournal.list("turn")).toHaveLength(1);
  } finally { stores.close(); rmSync(root, { recursive: true, force: true }); }
});

test("delivery acknowledgement and release reject conflicting exact states", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-exact-replay-state-"));
  const stores = openBtccSqliteStores({ dbPath: join(root, "btcc.sqlite"), ownerId: "state" });
  try {
    stores.guidedToolJournal.start({ turnId: "turn", callId: "call", toolName: "read_file", rawArguments: "{}", arguments: {} });
    stores.guidedToolJournal.finish({ callId: "call", status: "completed", result: { content: "S".repeat(9_000) } });
    const replay = createOperationResultReplay({ turnId: "turn", turnRevision: 1, journal: stores.guidedToolJournal, exactReader: stores.guidedOperationResultReader, exactReadCapability: true });
    const messages = [{ role: "tool" as const, toolCallId: "call", content: "S".repeat(9_000) }];
    replay.prepareMessages(messages, "round");
    expect(() => replay.failed("wrong-round"))
      .toThrow("operation_result_delivery_release_conflict");
    expect(() => replay.accepted("wrong-round", routeAccepted("wrong-round", "accepted")))
      .toThrow("operation_result_delivery_acknowledgement_conflict");
    replay.accepted("round", routeAccepted("round", "accepted"));
    replay.accepted("round", routeAccepted("round", "accepted"));
    expect(() => replay.accepted("round", routeAccepted("round", "different")))
      .toThrow("operation_result_delivery_acknowledgement_conflict");
    expect(() => replay.failed("round"))
      .toThrow("operation_result_delivery_release_conflict");
  } finally { stores.close(); rmSync(root, { recursive: true, force: true }); }
});

test("enabled replay refuses an uncheckpointed model success and preserves raw delivery", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-exact-replay-unaccepted-"));
  const stores = openBtccSqliteStores({ dbPath: join(root, "btcc.sqlite"), ownerId: "unaccepted" });
  try {
    stores.guidedToolJournal.start({
      turnId: "turn", callId: "call", toolName: "read_file", rawArguments: "{}", arguments: {},
    });
    stores.guidedToolJournal.finish({
      callId: "call", status: "completed", result: { content: "U".repeat(9_000) },
    });
    const replay = createOperationResultReplay({
      turnId: "turn", turnRevision: 1, journal: stores.guidedToolJournal,
      exactReader: stores.guidedOperationResultReader, exactReadCapability: true,
    });
    const messages = [{ role: "tool" as const, toolCallId: "call", content: "U".repeat(9_000) }];
    replay.prepareMessages(messages, "round");
    expect(() => replay.accepted("round", { text: "not durable", toolCalls: [] }))
      .toThrow("operation_result_route_acceptance_missing");
    expect(replay.prepareMessages(messages, "round")[0]!.content).toContain("U".repeat(1024));
  } finally {
    stores.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("every durable delivery state resumes exactly across SQLite close and reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-exact-replay-states-"));
  const dbPath = join(root, "btcc.sqlite");
  const message = { role: "tool" as const, toolCallId: "call", content: "D".repeat(9_000) };
  const openReplay = (ownerId: string) => {
    const stores = openBtccSqliteStores({ dbPath, ownerId });
    return { stores, replay: createOperationResultReplay({
      turnId: "turn", turnRevision: 1, journal: stores.guidedToolJournal,
      exactReader: stores.guidedOperationResultReader, exactReadCapability: true,
    }) };
  };
  try {
    let current = openReplay("pending-writer");
    current.stores.guidedToolJournal.start({
      turnId: "turn", callId: "call", toolName: "read_file",
      rawArguments: "{}", arguments: {},
    });
    current.stores.guidedToolJournal.finish({
      callId: "call", status: "completed", result: { content: "D".repeat(9_000) },
    });
    current.stores.guidedToolJournal.admitResultDelivery({ turnId: "turn", callId: "call" });
    current.stores.close();

    current = openReplay("pending-reader");
    expect(current.replay.prepareMessages([message], "round-a")[0]!.content).toBe(message.content);
    current.stores.close();

    current = openReplay("in-flight-reader");
    expect(current.replay.prepareMessages([message], "round-a")[0]!.content).toBe(message.content);
    expect(() => current.replay.prepareMessages([message], "stale-round"))
      .toThrow("operation_result_delivery_in_flight_mismatch");
    expect(() => current.replay.accepted("stale-round", routeAccepted("stale-round", "stale")))
      .toThrow("operation_result_delivery_acknowledgement_conflict");
    expect(() => current.replay.failed("stale-round"))
      .toThrow("operation_result_delivery_release_conflict");
    current.replay.failed("round-a");
    expect(current.replay.prepareMessages([message], "round-b")[0]!.content).toBe(message.content);
    current.replay.accepted("round-b", routeAccepted("round-b", "accepted"));
    current.stores.close();

    current = openReplay("acknowledged-reader");
    const promoted = current.replay.prepareMessages([message], "round-c")[0]!.content;
    expect(promoted).toContain("butler.operation-result-reference.v1");
    current.stores.close();

    current = openReplay("reference-only-reader");
    expect(current.replay.prepareMessages([message], "round-d")[0]!.content).toBe(promoted);
    expect(current.replay.prepareMessages([message], "round-e")[0]!.content).toBe(promoted);
    current.stores.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enabled replay stays raw through routed retry, acknowledges once, and resumes route checkpoints", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-exact-replay-route-"));
  const dbPath = join(root, "btcc.sqlite");
  const stores = openBtccSqliteStores({ dbPath, ownerId: "route-writer" });
  const large = { content: "Q".repeat(12_000) };
  stores.guidedToolJournal.start({
    turnId: "turn", callId: "journal-large", toolName: "read_file",
    rawArguments: "{}", arguments: {},
  });
  stores.guidedToolJournal.finish({
    callId: "journal-large", status: "completed", result: large,
  });
  const replay = createOperationResultReplay({
    turnId: "turn", turnRevision: 1, journal: stores.guidedToolJournal,
    exactReader: stores.guidedOperationResultReader, exactReadCapability: true,
  });
  const physicalMessages: string[] = [];
  const accepted = new Map<string, { text?: string; toolCalls: Array<{
    id: string; name: string; arguments: Record<string, unknown>; rawArguments: string;
  }> }>();
  let physicalCalls = 0;
  let executions = 0;
  const route = buildModelRoute({
    primaryModelRef: "openai/gpt-5.6-sol", backupModelRefs: [],
    reasoningEffort: "medium", retryCeiling: 2, catalogGeneration: "test",
  });
  const routed = createModelRoutePort({
    turnId: "turn", route,
    base: { async runRound(request) {
      physicalCalls += 1;
      physicalMessages.push(JSON.stringify(request.messages));
      if (physicalCalls === 1) return { toolCalls: [{
        id: "provider-large", name: "read_file", arguments: {}, rawArguments: "{}",
      }] };
      if (physicalCalls === 2) {
        throw new ModelProviderRequestError({
          code: "provider_rate_limited", message: "retry", provider: "openai",
          retryable: true,
        });
      }
      if (physicalCalls === 3) return { toolCalls: [{
        id: "provider-small", name: "read_file", arguments: {}, rawArguments: "{}",
      }] };
      return { text: "route accepted", toolCalls: [] };
    } },
    recordAcceptedResponse: async (input) => {
      accepted.set(input.roundId, input.result);
    },
  });
  try {
    const output = await runBtccAgentLoop({
      prompt: "read", turnId: "turn", model: "openai/gpt-5.6-sol",
      tools: [{ name: "read_file", description: "Read", parameters: { type: "object" } }],
      modelRound: routed, operationResultReplay: replay,
      resolveOperationResultCallId: (providerCallId) =>
        providerCallId === "provider-large" ? "journal-large" : undefined,
      executeTool: async (call) => {
        executions += 1;
        return call.id === "provider-large" ? large : { content: "small" };
      },
    });
    expect(output.finalText).toBe("route accepted");
    expect(executions).toBe(2);
    expect(stores.guidedToolJournal.list("turn")).toHaveLength(1);
    expect(physicalMessages[1]).toContain("Q".repeat(1024));
    expect(physicalMessages[2]).toContain("Q".repeat(1024));
    expect(physicalMessages[3]).not.toContain("Q".repeat(1024));
    expect(physicalMessages[3]).toContain("butler.operation-result-reference.v1");
    expect(stores.guidedToolJournal.findForTurn("turn", "journal-large")?.deliveryState)
      .toBe("reference_only");
    stores.close();

    const resumed = openBtccSqliteStores({ dbPath, ownerId: "route-reader" });
    let redispatches = 0;
    const recoveredRoute = createModelRoutePort({
      turnId: "turn", route,
      base: { async runRound() {
        redispatches += 1;
        throw new Error("route checkpoint redispatched");
      } },
      loadAcceptedResponse: async ({ roundId }) => accepted.get(roundId),
    });
    const stableReference = createOperationResultReplay({
      turnId: "turn", turnRevision: 1, journal: resumed.guidedToolJournal,
      exactReader: resumed.guidedOperationResultReader, exactReadCapability: true,
    }).prepareMessages([{
      role: "tool", toolCallId: "provider-large", operationResultCallId: "journal-large",
      content: JSON.stringify(large),
    }], "btcc-model-round-1");
    await expect(recoveredRoute.runRound({
      roundId: "btcc-model-round-1", model: "openai/gpt-5.6-sol",
      messages: stableReference, tools: [],
    })).resolves.toMatchObject(accepted.get("btcc-model-round-1")!);
    expect(redispatches).toBe(0);
    expect(stableReference[0]!.content).toContain("butler.operation-result-reference.v1");
    resumed.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("admission keeps small, failed, and non-durable terminal results raw", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-exact-replay-policy-"));
  const stores = openBtccSqliteStores({ dbPath: join(root, "btcc.sqlite"), ownerId: "policy" });
  try {
    stores.guidedToolJournal.start({ turnId: "turn", callId: "small", toolName: "read_file", rawArguments: "{}", arguments: {} });
    stores.guidedToolJournal.finish({ callId: "small", status: "completed", result: { ok: true, value: "small" } });
    stores.guidedToolJournal.start({ turnId: "turn", callId: "failed", toolName: "read_file", rawArguments: "{}", arguments: {} });
    stores.guidedToolJournal.finish({ callId: "failed", status: "failed", result: { ok: false, error: "meaningful failure" }, errorCode: "read_failed" });
    const replay = createOperationResultReplay({ turnId: "turn", turnRevision: 1, journal: stores.guidedToolJournal, exactReader: stores.guidedOperationResultReader, exactReadCapability: true });
    const messages = [
      { role: "tool" as const, toolCallId: "small", content: "small terminal meaning" },
      { role: "tool" as const, toolCallId: "failed", content: "meaningful failure" },
      { role: "tool" as const, toolCallId: "ephemeral", content: "ephemeral terminal meaning" },
    ];
    expect(replay.prepareMessages(messages, "round").map((message) => message.content))
      .toEqual(messages.map((message) => message.content));
  } finally { stores.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Work result references use canonical identity and fail closed across scope and kind", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-exact-replay-work-"));
  const dbPath = join(root, "btcc.sqlite");
  const stores = openBtccSqliteStores({ dbPath, ownerId: "work" });
  try {
    stores.guidedToolJournal.start({ turnId: "turn", callId: "call", toolName: "read_file", rawArguments: "{}", arguments: {} });
    stores.guidedToolJournal.finish({ callId: "call", status: "completed", result: { ok: true, content: "W".repeat(16_000) } });
    const db = new Database(dbPath);
    db.query(`INSERT INTO btcc_guided_works (
      work_id, session_id, scope_kind, scope_ref, origin_turn_id, origin_message_id,
      objective, status, created_at, updated_at
    ) VALUES (?, ?, 'project', ?, ?, 'message', 'objective', 'open', ?, ?)`)
      .run("work", "session", "project", "turn", "now", "now");
    db.query(`INSERT INTO btcc_guided_work_results (
      result_ref, work_id, sequence, tool_call_id, origin_turn_id, attached_at
    ) VALUES (?, ?, 3, ?, ?, ?)`)
      .run("canonical-result", "work", "call", "turn", "now");
    db.close();
    const replay = createOperationResultReplay({
      turnId: "turn", turnRevision: 9, journal: stores.guidedToolJournal,
      exactReader: stores.guidedOperationResultReader,
      exactReadCapability: true, sessionId: "session", projectRef: "project",
    });
    const reference = replay.referenceFor(stores.guidedToolJournal.findForTurn("turn", "call")!);
    expect(reference.identity).toMatchObject({ kind: "work", result_ref: "canonical-result", work_id: "work" });
    expect(reference.integrity.revision).toBe(3);
    const laterTurnReplay = createOperationResultReplay({
      turnId: "later-turn", turnRevision: 1, journal: stores.guidedToolJournal,
      exactReader: stores.guidedOperationResultReader,
      exactReadCapability: true, sessionId: "session", projectRef: "project",
    });
    expect(laterTurnReplay.readExact(exactPage(
      "canonical-result", reference.integrity.sha256, 3, "work",
    ))).toMatchObject({ encoding: "base64", offset: 0, length: 32 });
    const wrongScope = createOperationResultReplay({
      turnId: "turn", turnRevision: 9, journal: stores.guidedToolJournal,
      exactReader: stores.guidedOperationResultReader,
      exactReadCapability: true, sessionId: "session", projectRef: "other",
    });
    expect(() => wrongScope.readExact(exactPage("canonical-result", reference.integrity.sha256, 3, "work")))
      .toThrow("operation_result_scope_mismatch");
    const wrongSession = createOperationResultReplay({
      turnId: "turn", turnRevision: 9, journal: stores.guidedToolJournal,
      exactReader: stores.guidedOperationResultReader,
      exactReadCapability: true, sessionId: "other", projectRef: "project",
    });
    expect(() => wrongSession.readExact(exactPage("canonical-result", reference.integrity.sha256, 3, "work")))
      .toThrow("operation_result_session_mismatch");
    const wrongWork = createOperationResultReplay({
      turnId: "turn", turnRevision: 9, journal: stores.guidedToolJournal,
      exactReader: stores.guidedOperationResultReader,
      exactReadCapability: true, sessionId: "session", projectRef: "project",
    });
    expect(() => wrongWork.readExact(exactPage("canonical-result", reference.integrity.sha256, 3, "other")))
      .toThrow("operation_result_work_mismatch");
    expect(() => replay.readExact(exactPage("canonical-result", reference.integrity.sha256, 2, "work")))
      .toThrow("operation_result_revision_mismatch");
    expect(() => replay.readExact(exactPage("missing", reference.integrity.sha256, 3, "work")))
      .toThrow("operation_result_missing_or_scope_mismatch");
    expect(() => replay.readExact(exactPage("canonical-result", "0".repeat(64), 3, "work")))
      .toThrow("operation_result_integrity_mismatch");
    const scoped = new Database(dbPath);
    scoped.query("UPDATE btcc_guided_works SET scope_kind = 'session', scope_ref = ? WHERE work_id = ?")
      .run("session", "work");
    scoped.close();
    const sessionReplay = createOperationResultReplay({
      turnId: "later-turn", turnRevision: 1, journal: stores.guidedToolJournal,
      exactReader: stores.guidedOperationResultReader, exactReadCapability: true,
      sessionId: "session",
    });
    expect(sessionReplay.readExact(exactPage(
      "canonical-result", reference.integrity.sha256, 3, "work",
    ))).toMatchObject({ encoding: "base64" });
    const crossKind = createOperationResultReplay({
      turnId: "later-turn", turnRevision: 1, journal: stores.guidedToolJournal,
      exactReader: stores.guidedOperationResultReader, exactReadCapability: true,
      sessionId: "session", projectRef: "project",
    });
    expect(() => crossKind.readExact(exactPage(
      "canonical-result", reference.integrity.sha256, 3, "work",
    ))).toThrow("operation_result_scope_mismatch");
    const corruptScope = new Database(dbPath);
    corruptScope.query("UPDATE btcc_guided_works SET scope_ref = ? WHERE work_id = ?")
      .run("other-session", "work");
    corruptScope.close();
    expect(() => sessionReplay.readExact(exactPage(
      "canonical-result", reference.integrity.sha256, 3, "work",
    ))).toThrow("operation_result_scope_mismatch");
    const corrupt = new Database(dbPath);
    corrupt.query("UPDATE btcc_guided_works SET scope_kind = 'project', scope_ref = ? WHERE work_id = ?")
      .run("project", "work");
    corrupt.query("UPDATE btcc_guided_tool_calls SET result_json = ? WHERE call_id = ?")
      .run(JSON.stringify({ ok: true, content: "tampered" }), "call");
    corrupt.close();
    expect(() => replay.readExact(exactPage("canonical-result", reference.integrity.sha256, 3, "work")))
      .toThrow("operation_result_body_hash_mismatch");
  } finally { stores.close(); rmSync(root, { recursive: true, force: true }); }
});

test("reference identity is stable and exact reads fail closed across restart and mismatches", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-exact-replay-restart-"));
  const dbPath = join(root, "btcc.sqlite");
  try {
    const first = openBtccSqliteStores({ dbPath, ownerId: "writer" });
    first.guidedToolJournal.start({ turnId: "turn-restart", callId: "durable-read", toolName: "read_file", rawArguments: "{}", arguments: {} });
    first.guidedToolJournal.finish({ callId: "durable-read", status: "completed", result: { content: "R".repeat(20_000) } });
    const replay = createOperationResultReplay({ turnId: "turn-restart", turnRevision: 11, journal: first.guidedToolJournal, exactReader: first.guidedOperationResultReader, exactReadCapability: true });
    const reference = replay.referenceFor(first.guidedToolJournal.find("durable-read")!);
    first.close();
    const resumed = openBtccSqliteStores({ dbPath, ownerId: "reader" });
    const resumedReplay = createOperationResultReplay({ turnId: "turn-restart", turnRevision: 11, journal: resumed.guidedToolJournal, exactReader: resumed.guidedOperationResultReader, exactReadCapability: true });
    expect(resumedReplay.referenceFor(resumed.guidedToolJournal.find("durable-read")!)).toEqual(reference);
    expect(reference.integrity.revision).toBeNull();
    const page = resumedReplay.readExact(exactPage(
      reference.identity.result_ref, reference.integrity.sha256, null,
    )) as { data: string; length: number };
    expect(Buffer.from(page.data, "base64")).toHaveLength(page.length);
    expect(JSON.stringify(page).length).toBeLessThan(6_000);
    const maxPage = resumedReplay.readExact({
      ...exactPage(reference.identity.result_ref, reference.integrity.sha256, null),
      offset: 4_000, length: 4_096,
    }) as {
      data: string; offset: number; length: number; totalBytes: number;
      nextOffset: number | null;
    };
    expect(Buffer.from(maxPage.data, "base64")).toHaveLength(4_096);
    expect(maxPage).toMatchObject({ offset: 4_000, length: 4_096, nextOffset: 8_096 });
    expect(JSON.stringify(maxPage).length).toBeLessThan(6_000);
    expect(() => resumedReplay.readExact({
      ...exactPage(reference.identity.result_ref, reference.integrity.sha256, null),
      offset: maxPage.totalBytes, length: 1,
    })).toThrow("operation_result_range_out_of_bounds");
    expect(() => exactReadArguments({
      result_ref: reference.identity.result_ref, sha256: reference.integrity.sha256,
      revision: null, work_id: null, offset: 0, length: 4_097,
    })).toThrow("operation_result_length_invalid");
    expect(() => resumedReplay.readExact(exactPage(reference.identity.result_ref, "0".repeat(64), null))).toThrow("operation_result_integrity_mismatch");
    expect(() => resumedReplay.readExact(exactPage(reference.identity.result_ref, reference.integrity.sha256, 12))).toThrow("operation_result_revision_mismatch");
    resumed.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
