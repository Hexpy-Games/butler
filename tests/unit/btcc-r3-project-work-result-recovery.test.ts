import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyWorkActionUpdates,
  createDurableWorkService,
  dispositionMaterialFingerprint,
  type DurableWorkView,
  type RecordWorkDispositionCommand,
} from "../../packages/butler-agent/src/agent/btcc/work/index.ts";
import {
  createProjectWorkStore,
  createExactProjectWorkResultAuthority,
  observeProjectLedgerHead,
  type ProjectWorkOperationIdentity,
  type ProjectWorkRuntimeProjection,
} from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/index.ts";
import { captureMaterialSnapshot } from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/project-work-material-snapshot.ts";
import { canonicalProjectWorkChildBody } from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/project-work-child-codec.ts";
import { loadProjectLedgerCore } from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/project-ledger-core.ts";
import { SqliteGuidedOperationResultReader } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/guided-operation-result-reader.ts";
import { SqliteProjectWorkResultRuntime } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/project-work-result-runtime.ts";
import { BTCC_SUCCESSOR_SCHEMA } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("public Project Work service publishes Result before SQLite projection and replays current view", async () => {
  const fixture = await createFixture();
  const scope = fixture.scope("turn-1");
  const started = await fixture.service.startWork({
    ...scope, mutationCallId: "start-1", objective: "Recover Project results",
  });
  fixture.insertResult("turn-1", "tool-1", "read_file", { ok: true, text: "value" });
  const attached = await fixture.service.attachToolResult({
    ...scope, mutationCallId: "attach-1", toolCallId: "tool-1",
  });
  expect(attached.resultRefs).toHaveLength(1);
  expect(fixture.resultLink("tool-1")).toMatchObject({
    work_id: started.workId, sequence: 1,
  });
  const ledgerAfterAttach = fixture.ledgerText();

  fixture.insertTurn("turn-2");
  fixture.runtime.originals.set("turn-2", {
    turnId: "turn-2", messageId: "message-turn-2", content: "continue",
  });
  const current = await fixture.service.continueWork({
    ...fixture.scope("turn-2"), mutationCallId: "continue-2", workId: started.workId,
  });
  const restartedService = createDurableWorkService(
    createProjectWorkStore(fixture.adapterInput),
  );
  const ledgerBeforeAttachReplay = fixture.ledgerText();
  const ledgerHashBeforeAttachReplay = sha(ledgerBeforeAttachReplay);
  const replayed = await restartedService.attachToolResult({
    ...scope, mutationCallId: "attach-1", toolCallId: "tool-1",
  });
  expect(replayed).toEqual(current);
  expect(fixture.resultCount()).toBe(1);
  expect(fixture.ledgerText()).toBe(ledgerBeforeAttachReplay);
  expect(sha(fixture.ledgerText())).toBe(ledgerHashBeforeAttachReplay);
  expect(fixture.ledgerText()).not.toBe(ledgerAfterAttach);
  expect(await fixture.service.claimCloseoutCorrection({
    ...fixture.scope("turn-2"), workId: started.workId,
  })).toBe(true);
  expect(await fixture.service.claimCloseoutCorrection({
    ...fixture.scope("turn-2"), workId: started.workId,
  })).toBe(false);

  const reader = new SqliteGuidedOperationResultReader(
    fixture.db,
    await createExactProjectWorkResultAuthority({
      butlerData: fixture.adapterInput.butlerData,
      scope: fixture.adapterInput.scope,
      workIds: [started.workId],
    }),
  );
  const identity = reader.resolveResultReference({
    turnId: "turn-1", callId: "tool-1",
  });
  const resultSha256 = attached.resultRefs[0]!.resultSha256!;
  const ledgerBeforeReplayRead = fixture.ledgerText();
  expect(identity).toMatchObject({ kind: "work", revision: 1, workId: started.workId });
  expect(reader.readExactResultRange({
    turnId: "turn-1", resultRef: identity.resultRef, resultSha256,
    revision: 1, sessionId: "session-1", projectRef: "app-project",
    workId: started.workId, offset: 0, length: 8,
  }).totalBytes).toBeGreaterThan(8);
  expect(fixture.ledgerText()).toBe(ledgerBeforeReplayRead);
  expect(() => reader.readExactResultRange({
    turnId: "turn-1", resultRef: identity.resultRef, resultSha256,
    revision: 1, sessionId: "wrong-session", projectRef: "app-project",
    workId: started.workId, offset: 0, length: 1,
  })).toThrow("operation_result_session_mismatch");
  expect(() => reader.readExactResultRange({
    turnId: "turn-1", resultRef: identity.resultRef, resultSha256,
    revision: 1, sessionId: "session-1", projectRef: "wrong-app",
    workId: started.workId, offset: 0, length: 1,
  })).toThrow("operation_result_scope_mismatch");
  fixture.db.query(
    "UPDATE btcc_guided_works SET ledger_project_id = 'wrong-ledger' WHERE work_id = ?",
  ).run(started.workId);
  expect(() => reader.readExactResultRange({
    turnId: "turn-1", resultRef: identity.resultRef, resultSha256,
    revision: 1, sessionId: "session-1", projectRef: "app-project",
    workId: started.workId, offset: 0, length: 1,
  })).toThrow("operation_result_project_reference_mismatch");
  fixture.db.query(
    "UPDATE btcc_guided_works SET ledger_project_id = 'ledger-project', scope_kind = 'session', scope_ref = 'session-1' WHERE work_id = ?",
  ).run(started.workId);
  expect(() => reader.readExactResultRange({
    turnId: "turn-1", resultRef: identity.resultRef, resultSha256,
    revision: 1, sessionId: "session-1", projectRef: "app-project",
    workId: started.workId, offset: 0, length: 1,
  })).toThrow("operation_result_scope_mismatch");
  fixture.close();
});

test("Project Work advances the SQLite session head to the canonical replacement", async () => {
  const fixture = await createFixture(undefined, true);
  const first = await fixture.service.startWork({
    ...fixture.scope("turn-1"),
    mutationCallId: "start-first",
    objective: "First Project Work",
  });
  fixture.insertTurn("turn-2");
  fixture.runtime.originals.set("turn-2", {
    turnId: "turn-2",
    messageId: "message-turn-2",
    content: "replace",
  });

  const replacement = await fixture.service.startWork({
    ...fixture.scope("turn-2"),
    mutationCallId: "start-replacement",
    objective: "Replacement Project Work",
  });

  expect(fixture.db.query<{ status: string }, [string]>(
    "SELECT status FROM btcc_guided_works WHERE work_id = ?",
  ).get(first.workId)?.status).toBe("abandoned");
  expect(fixture.db.query<{ work_id: string }, [string]>(
    "SELECT work_id FROM btcc_guided_work_session_heads WHERE session_id = ?",
  ).get("session-1")?.work_id).toBe(replacement.workId);
  fixture.close();
});

test("two canonical Results attach to one Work and the second replays without mutation", async () => {
  const fixture = await createFixture(undefined, true);
  const firstScope = fixture.scope("turn-1");
  const work = await fixture.service.startWork({
    ...firstScope,
    mutationCallId: "start-two-results",
    objective: "attach two results",
  });
  fixture.insertResult("turn-1", "first-tool", "read_file", { value: 1 });
  const first = await fixture.service.attachToolResult({
    ...firstScope,
    mutationCallId: "attach-first",
    toolCallId: "first-tool",
  });

  fixture.insertTurn("turn-2");
  fixture.runtime.originals.set("turn-2", {
    turnId: "turn-2", messageId: "message-turn-2", content: "second",
  });
  await fixture.service.continueWork({
    ...fixture.scope("turn-2"),
    mutationCallId: "continue-second",
    workId: work.workId,
  });
  fixture.insertResult("turn-2", "second-tool", "read_file", { value: 2 });
  const second = await fixture.service.attachToolResult({
    ...fixture.scope("turn-2"),
    mutationCallId: "attach-second",
    toolCallId: "second-tool",
  });
  expect(second.resultRefs.map((result) => result.resultRef)).toEqual([
    first.resultRefs[0]!.resultRef,
    second.resultRefs[1]!.resultRef,
  ]);
  expect(fixture.resultLink("first-tool")).toMatchObject({
    work_id: work.workId, sequence: 1,
  });
  expect(fixture.resultLink("second-tool")).toMatchObject({
    work_id: work.workId, sequence: 2,
  });
  expect(fixture.resultCount()).toBe(2);
  const authority = await createExactProjectWorkResultAuthority({
    butlerData: fixture.adapterInput.butlerData,
    scope: fixture.adapterInput.scope,
    workIds: [work.workId],
  });
  expect(authority.resolve({ turnId: "turn-1", callId: "first-tool" }))
    .toMatchObject({ workId: work.workId, revision: 1 });
  expect(authority.resolve({ turnId: "turn-2", callId: "second-tool" }))
    .toMatchObject({ workId: work.workId, revision: 2 });
  const workRecord = fixture.core.resolveRecord(fixture.projectRoot, {
    kind: "work", id: work.workId,
  });
  expect(JSON.parse(fixture.core.readRecordBody(workRecord.filePath)!).resultSequence)
    .toBe(2);

  fixture.insertTurn("turn-3");
  fixture.runtime.originals.set("turn-3", {
    turnId: "turn-3", messageId: "message-turn-3", content: "later",
  });
  const current = await fixture.service.continueWork({
    ...fixture.scope("turn-3"),
    mutationCallId: "continue-later",
    workId: work.workId,
  });
  const ledgerBeforeReplay = fixture.ledgerText();
  const ledgerHashBeforeReplay = sha(ledgerBeforeReplay);
  const replayed = await fixture.service.attachToolResult({
    ...fixture.scope("turn-2"),
    mutationCallId: "attach-second",
    toolCallId: "second-tool",
  });
  expect(replayed).toEqual(current);
  expect(fixture.resultCount()).toBe(2);
  expect(fixture.ledgerText()).toBe(ledgerBeforeReplay);
  expect(sha(fixture.ledgerText())).toBe(ledgerHashBeforeReplay);
  fixture.close();
});

test("managed Project identity never downgrades to direct when its link or authority is missing", async () => {
  const fixture = await createFixture();
  const scope = fixture.scope("turn-1");
  const work = await fixture.service.startWork({
    ...scope, mutationCallId: "start-no-downgrade", objective: "no downgrade",
  });
  fixture.insertResult("turn-1", "managed-tool", "read_file", { ok: true });
  await fixture.service.attachToolResult({
    ...scope, mutationCallId: "attach-no-downgrade", toolCallId: "managed-tool",
  });
  const authority = await createExactProjectWorkResultAuthority({
    butlerData: fixture.adapterInput.butlerData,
    scope: fixture.adapterInput.scope,
    workIds: [work.workId],
  });
  expect(() => new SqliteGuidedOperationResultReader(fixture.db)
    .resolveResultReference({ turnId: "turn-1", callId: "managed-tool" }))
    .toThrow("operation_result_project_authority_missing");
  fixture.db.query("DELETE FROM btcc_guided_work_results WHERE tool_call_id = 'managed-tool'").run();
  const reader = new SqliteGuidedOperationResultReader(fixture.db, authority);
  expect(() => reader.resolveResultReference({
    turnId: "turn-1", callId: "managed-tool",
  }))
    .toThrow("operation_result_project_projection_mismatch");
  fixture.insertResult("turn-1", "unmanaged-tool", "read_file", { direct: true });
  const direct = reader.resolveResultReference({
    turnId: "turn-1", callId: "unmanaged-tool",
  });
  expect(direct).toEqual({
    kind: "direct", resultRef: "unmanaged-tool", revision: null,
  });
  const directHash = fixture.db.query<{ result_sha256: string }, []>(
    "SELECT result_sha256 FROM btcc_guided_tool_calls WHERE call_id = 'unmanaged-tool'",
  ).get()!.result_sha256;
  expect(reader.readExactResultRange({
    turnId: "turn-1",
    resultRef: "unmanaged-tool",
    resultSha256: directHash,
    revision: null,
    sessionId: "session-1",
    projectRef: "app-project",
    offset: 0,
    length: 1,
  }).length).toBe(1);
  fixture.close();
});

test("Project authority verification occurs before SQLite payload bytes are read", async () => {
  const fixture = await createFixture();
  const scope = fixture.scope("turn-1");
  const work = await fixture.service.startWork({
    ...scope, mutationCallId: "start-order", objective: "verify first",
  });
  fixture.insertResult("turn-1", "ordered-tool", "read_file", { value: "original" });
  const attached = await fixture.service.attachToolResult({
    ...scope, mutationCallId: "attach-order", toolCallId: "ordered-tool",
  });
  const canonical = await createExactProjectWorkResultAuthority({
    butlerData: fixture.adapterInput.butlerData,
    scope: fixture.adapterInput.scope,
    workIds: [work.workId],
  });
  const authority = {
    resolve: canonical.resolve.bind(canonical),
    verify(input: Parameters<typeof canonical.verify>[0]) {
      const verified = canonical.verify(input);
      fixture.db.query(
        "UPDATE btcc_guided_tool_calls SET result_json = ? WHERE call_id = 'ordered-tool'",
      ).run('{"tampered":true}');
      return verified;
    },
  };
  const reader = new SqliteGuidedOperationResultReader(fixture.db, authority);
  expect(() => reader.readExactResultRange({
    turnId: "turn-1",
    resultRef: attached.resultRefs[0]!.resultRef,
    resultSha256: attached.resultRefs[0]!.resultSha256!,
    revision: 1,
    sessionId: "session-1",
    projectRef: "app-project",
    workId: work.workId,
    offset: 0,
    length: 1,
  })).toThrow("operation_result_body_hash_mismatch");
  fixture.close();
});

test("recovered attachment repairs a missing SQLite link after Project promotion", async () => {
  let failProjection = true;
  const fixture = await createFixture((runtime) => ({
    readCommittedResult: runtime.readCommittedResult.bind(runtime),
    observeCanonicalResult(input) {
      if (failProjection) {
        failProjection = false;
        throw new Error("simulated_result_projection_failure");
      }
      runtime.observeCanonicalResult(input);
    },
  }));
  const scope = fixture.scope("turn-1");
  await fixture.service.startWork({ ...scope, mutationCallId: "start", objective: "repair" });
  fixture.insertResult("turn-1", "tool-recover", "read_file", { ok: true });
  await expect(fixture.service.attachToolResult({
    ...scope, mutationCallId: "attach-recover", toolCallId: "tool-recover",
  })).rejects.toThrow("The Project Ledger publication state could not be verified safely.");
  expect(fixture.resultCount()).toBe(0);
  expect((await fixture.service.loadContext(scope))?.work.resultRefs).toHaveLength(1);
  const recovered = await fixture.service.attachToolResult({
    ...scope, mutationCallId: "attach-recover", toolCallId: "tool-recover",
  });
  expect(recovered.resultRefs).toHaveLength(1);
  expect(fixture.resultCount()).toBe(1);
  fixture.close();
});

test("restart repairs the full thin Work, head, binding, and Result projection transactionally", async () => {
  const fixture = await createFixture(undefined, true);
  const scope = fixture.scope("turn-1");
  const work = await fixture.service.startWork({
    ...scope, mutationCallId: "start-full-recovery", objective: "full recovery",
  });
  fixture.insertResult("turn-1", "full-tool", "read_file", { ok: true });
  const attached = await fixture.service.attachToolResult({
    ...scope, mutationCallId: "attach-full-recovery", toolCallId: "full-tool",
  });
  fixture.db.transaction(() => {
    fixture.db.query("DELETE FROM btcc_guided_work_results WHERE work_id = ?").run(work.workId);
    fixture.db.query("DELETE FROM btcc_guided_turn_work_bindings WHERE work_id = ?").run(work.workId);
    fixture.db.query("DELETE FROM btcc_guided_work_session_heads WHERE work_id = ?").run(work.workId);
    fixture.db.query("DELETE FROM btcc_guided_works WHERE work_id = ?").run(work.workId);
  }).immediate();

  const restarted = createDurableWorkService(createProjectWorkStore(fixture.adapterInput));
  const recovered = await restarted.attachToolResult({
    ...scope, mutationCallId: "attach-full-recovery", toolCallId: "full-tool",
  });
  expect(recovered).toEqual(attached);
  expect(fixture.resultCount()).toBe(1);
  const canonicalHead = await observeProjectLedgerHead(fixture.projectRoot);
  expect(fixture.db.query<{
    session_id: string;
    scope_kind: string;
    scope_ref: string;
    ledger_project_id: string;
    canonical_head_sha256: string;
  }, [string]>(`
    SELECT session_id, scope_kind, scope_ref, ledger_project_id,
      canonical_head_sha256 FROM btcc_guided_works WHERE work_id = ?
  `).get(work.workId)).toEqual({
    session_id: "session-1",
    scope_kind: "project",
    scope_ref: "app-project",
    ledger_project_id: "ledger-project",
    canonical_head_sha256: canonicalHead.sourceSha256,
  });
  expect(fixture.db.query<{ work_id: string }, []>(
    "SELECT work_id FROM btcc_guided_work_session_heads",
  ).get()?.work_id).toBe(work.workId);
  expect(fixture.db.query<{ work_id: string }, []>(
    "SELECT work_id FROM btcc_guided_turn_work_bindings WHERE is_current = 1",
  ).get()?.work_id).toBe(work.workId);
  const authority = await createExactProjectWorkResultAuthority({
    butlerData: fixture.adapterInput.butlerData,
    scope: fixture.adapterInput.scope,
    workIds: [work.workId],
  });
  const reader = new SqliteGuidedOperationResultReader(fixture.db, authority);
  expect(reader.resolveResultReference({ turnId: "turn-1", callId: "full-tool" }))
    .toMatchObject({ kind: "work", workId: work.workId });
  expect(reader.readExactResultRange({
    turnId: "turn-1",
    resultRef: attached.resultRefs[0]!.resultRef,
    resultSha256: attached.resultRefs[0]!.resultSha256!,
    revision: 1,
    sessionId: "session-1",
    projectRef: "app-project",
    workId: work.workId,
    offset: 0,
    length: 1,
  }).length).toBe(1);
  fixture.close();
});

test("projection recovery rejects ownership collisions atomically", async () => {
  const conflicts: Array<{
    name: string;
    corrupt(fixture: Awaited<ReturnType<typeof createFixture>>, workId: string): void;
  }> = [
    {
      name: "Session Work with the same workId",
      corrupt: ({ db }, workId) => db.query(`
        UPDATE btcc_guided_works SET scope_kind = 'session',
          scope_ref = session_id, ledger_project_id = NULL
        WHERE work_id = ?
      `).run(workId),
    },
    {
      name: "another Project owner with the same workId",
      corrupt: ({ db }, workId) => db.query(`
        UPDATE btcc_guided_works SET scope_ref = 'other-app',
          ledger_project_id = 'other-ledger' WHERE work_id = ?
      `).run(workId),
    },
    {
      name: "another Work as the session head",
      corrupt: ({ db }) => db.query(`
        UPDATE btcc_guided_work_session_heads SET work_id = 'foreign-work'
        WHERE session_id = 'session-1'
      `).run(),
    },
    {
      name: "binding identity owned by another Work and session",
      corrupt: ({ db }) => db.query(`
        UPDATE btcc_guided_turn_work_bindings
        SET work_id = 'foreign-work', session_id = 'foreign-session'
        WHERE is_current = 1
      `).run(),
    },
    {
      name: "result ref and tool call owned by another Work",
      corrupt: ({ db }) => db.query(`
        UPDATE btcc_guided_work_results SET work_id = 'foreign-work'
        WHERE sequence = 1
      `).run(),
    },
    {
      name: "canonical sequence occupied by another Result identity",
      corrupt: ({ db }, workId) => db.query(`
        UPDATE btcc_guided_work_results
        SET result_ref = 'foreign-result', tool_call_id = 'foreign-tool'
        WHERE work_id = ? AND sequence = 1
      `).run(workId),
    },
  ];

  for (const conflict of conflicts) {
    const fixture = await createFixture(undefined, true);
    const scope = fixture.scope("turn-1");
    const work = await fixture.service.startWork({
      ...scope,
      mutationCallId: `start-${conflict.name}`,
      objective: conflict.name,
    });
    fixture.insertResult("turn-1", "owned-tool", "read_file", { ok: true });
    await fixture.service.attachToolResult({
      ...scope,
      mutationCallId: `attach-${conflict.name}`,
      toolCallId: "owned-tool",
    });
    conflict.corrupt(fixture, work.workId);
    const before = projectionState(fixture.db);
    const ledgerBefore = fixture.ledgerText();
    await expect(fixture.service.attachToolResult({
      ...scope,
      mutationCallId: `attach-${conflict.name}`,
      toolCallId: "owned-tool",
    })).rejects.toThrow(
      "The Project Ledger publication state could not be verified safely.",
    );
    expect(projectionState(fixture.db)).toEqual(before);
    expect(fixture.ledgerText()).toBe(ledgerBefore);
    fixture.close();
  }
});

test("late Result reopens completed review and clears stale result/completion pointers", async () => {
  const fixture = await createFixture();
  const scope = fixture.scope("turn-1");
  const started = await fixture.service.startWork({ ...scope, mutationCallId: "start", objective: "late" });
  await fixture.service.replacePlan({
    ...scope, mutationCallId: "plan", objective: "late",
    actions: [{ actionKey: "a", description: "a", dependencyKeys: [] }], checks: ["done"],
  });
  await fixture.service.recordReview({
    ...scope, mutationCallId: "plan-review", subject: "plan", verdict: "accept",
    summary: "ok", corrections: [],
  });
  await fixture.service.recordCheckpoint({
    ...scope, mutationCallId: "checkpoint", actionUpdates: [{ actionKey: "a", status: "done" }],
  });
  await fixture.service.recordReview({
    ...scope, mutationCallId: "result-review", subject: "result", verdict: "accept",
    summary: "ok", corrections: [],
  });
  const completion = await fixture.service.recordReview({
    ...scope, mutationCallId: "completion", subject: "completion", verdict: "accept",
    summary: "ok", corrections: [],
  });
  expect((await fixture.service.recordDisposition({
    ...scope, mutationCallId: "done", workId: started.workId,
    disposition: "completed", summary: "done",
    actionUpdates: [{ actionKey: "a", status: "done" }], evidenceRefs: [],
  })).status).toBe("completed");
  expect(completion.latestCompletionValidation).toBeDefined();
  fixture.insertResult("turn-1", "late-tool", "read_file", { late: true });
  const reopened = await fixture.service.attachToolResult({
    ...scope, mutationCallId: "attach-late", toolCallId: "late-tool",
  });
  expect(reopened.status).toBe("open");
  expect(reopened.latestResultReview).toBeUndefined();
  expect(reopened.latestCompletionValidation).toBeUndefined();
  const workRecord = fixture.core.resolveRecord(fixture.projectRoot, { kind: "work", id: started.workId });
  expect(workRecord.record.status).toBe("in_progress");
  const workBody = JSON.parse(fixture.core.readRecordBody(workRecord.filePath)!);
  delete workBody.latestPlanReviewRevisionId;
  fixture.core.updateRecord(fixture.projectRoot, {
    kind: "work", id: started.workId, body: JSON.stringify(workBody),
  });
  fixture.core.writeIndex(fixture.projectRoot);
  await expect(fixture.service.loadContext(scope)).rejects.toThrow(
    "project_work_managed_record_invalid",
  );
  fixture.close();
});

test("Project record and SQLite body or stored hash tamper fail closed", async () => {
  const fixture = await createFixture();
  const scope = fixture.scope("turn-1");
  const work = await fixture.service.startWork({ ...scope, mutationCallId: "start", objective: "tamper" });
  fixture.insertResult("turn-1", "tool", "read_file", { value: "clean" });
  const attached = await fixture.service.attachToolResult({
    ...scope, mutationCallId: "attach", toolCallId: "tool",
  });
  const authority = await createExactProjectWorkResultAuthority({
    butlerData: fixture.adapterInput.butlerData,
    scope: fixture.adapterInput.scope,
    workIds: [work.workId],
  });
  const reader = new SqliteGuidedOperationResultReader(fixture.db, authority);
  const exact = () => reader.readExactResultRange({
    turnId: "turn-1", resultRef: attached.resultRefs[0]!.resultRef,
    resultSha256: attached.resultRefs[0]!.resultSha256!, revision: 1,
    sessionId: "session-1", projectRef: "app-project", workId: work.workId,
    offset: 0, length: 1,
  });
  const originalBody = fixture.db.query<{ result_json: string }, []>(
    "SELECT result_json FROM btcc_guided_tool_calls WHERE call_id = 'tool'",
  ).get()!.result_json;
  fixture.db.query("UPDATE btcc_guided_tool_calls SET result_json = ? WHERE call_id = 'tool'").run('{"tampered":true}');
  expect(exact).toThrow("operation_result_body_hash_mismatch");
  fixture.db.query("UPDATE btcc_guided_tool_calls SET result_json = ?, result_sha256 = ? WHERE call_id = 'tool'").run(originalBody, "0".repeat(64));
  expect(exact).toThrow("operation_result_project_reference_mismatch");

  const workRecord = fixture.core.resolveRecord(fixture.projectRoot, {
    kind: "work", id: work.workId,
  });
  const workText = readFileSync(workRecord.filePath, "utf8");
  writeFileSync(workRecord.filePath, workText.replace('"appProjectId":"app-project"', '"appProjectId":"tampered"'));
  fixture.core.writeIndex(fixture.projectRoot);
  await expect(createExactProjectWorkResultAuthority({
    butlerData: fixture.adapterInput.butlerData,
    scope: fixture.adapterInput.scope,
    workIds: [work.workId],
  })).rejects.toThrow("project_work_managed_record_invalid");
  writeFileSync(workRecord.filePath, workText);
  fixture.core.writeIndex(fixture.projectRoot);

  const reference = fixture.core.resolveRecord(fixture.projectRoot, {
    kind: "reference", id: attached.resultRefs[0]!.resultRef,
  });
  const text = readFileSync(reference.filePath, "utf8");
  const originalChild = JSON.parse(markdownBody(text));
  const { recordSha256: _recordSha256, ...semantic } = originalChild;
  semantic.result.toolName = "write_file";
  writeFileSync(
    reference.filePath,
    text.replace(markdownBody(text), canonicalProjectWorkChildBody(semantic)),
  );
  fixture.core.writeIndex(fixture.projectRoot);
  await expect(createExactProjectWorkResultAuthority({
    butlerData: fixture.adapterInput.butlerData,
    scope: fixture.adapterInput.scope,
    workIds: [work.workId],
  })).rejects.toThrow("project_work_publication_proof_invalid");
  fixture.close();
});

test("attachment rejects cross-Turn, unfinished, and Work-control journal results before publication", async () => {
  const fixture = await createFixture();
  const scope = fixture.scope("turn-1");
  await fixture.service.startWork({ ...scope, mutationCallId: "start", objective: "eligibility" });
  fixture.insertTurn("turn-2");
  fixture.insertResult("turn-2", "cross-turn", "read_file", { ok: true });
  await expect(fixture.service.attachToolResult({
    ...scope, mutationCallId: "cross", toolCallId: "cross-turn",
  })).rejects.toThrow("The Project Ledger publication state could not be verified safely.");
  fixture.insertResult("turn-1", "control", "record_work_review", { ok: true });
  await expect(fixture.service.attachToolResult({
    ...scope, mutationCallId: "control-attach", toolCallId: "control",
  })).rejects.toThrow("The Project Ledger publication state could not be verified safely.");
  fixture.insertResult("turn-1", "unfinished", "read_file", { ok: true });
  fixture.db.query("UPDATE btcc_guided_tool_calls SET status = 'started' WHERE call_id = 'unfinished'").run();
  await expect(fixture.service.attachToolResult({
    ...scope, mutationCallId: "unfinished-attach", toolCallId: "unfinished",
  })).rejects.toThrow("The Project Ledger publication state could not be verified safely.");
  expect(fixture.resultCount()).toBe(0);
  fixture.close();
});

async function createFixture(
  wrapResultRuntime?: (runtime: SqliteProjectWorkResultRuntime) => SqliteProjectWorkResultRuntime | {
    readCommittedResult: SqliteProjectWorkResultRuntime["readCommittedResult"];
    observeCanonicalResult: SqliteProjectWorkResultRuntime["observeCanonicalResult"];
  },
  fullProjection = false,
) {
  const root = mkdtempSync(join(tmpdir(), "btcc-project-result-"));
  roots.push(root);
  const butlerData = join(root, "butler-data");
  const requested = join(butlerData, "project-ledger", "projects", "ledger-project");
  mkdirSync(requested, { recursive: true });
  const projectRoot = realpathSync(requested);
  writeFileSync(join(projectRoot, "project.json"), `${JSON.stringify({
    schema: "project-ledger.project.v1", id: "ledger-project", name: "Fixture", status: "active",
  }, null, 2)}\n`);
  writeFileSync(join(projectRoot, "ledger.jsonl"), "");
  const core = await loadProjectLedgerCore();
  core.writeIndex(projectRoot);
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  insertTurn(db, "turn-1");
  const concrete = new SqliteProjectWorkResultRuntime(db);
  const runtime = new ResultTestRuntime(
    db,
    fullProjection ? concrete : undefined,
  );
  runtime.originals.set("turn-1", {
    turnId: "turn-1", messageId: "message-turn-1", content: "start",
  });
  const adapterInput = {
    butlerData,
    scope: { appProjectId: "app-project", ledgerProjectId: "ledger-project", ledgerRoot: projectRoot },
    runtimeProjection: runtime,
    resultRuntime: wrapResultRuntime?.(concrete) ?? concrete,
  };
  return {
    db, core, projectRoot, runtime, adapterInput,
    service: createDurableWorkService(createProjectWorkStore(adapterInput)),
    scope: (turnId: string) => ({ turnId, sessionId: "session-1", projectRef: "app-project" }),
    insertTurn: (turnId: string) => insertTurn(db, turnId),
    insertResult(turnId: string, callId: string, toolName: string, result: unknown) {
      const resultJson = JSON.stringify({ ok: true, output: result });
      db.query(`INSERT INTO btcc_guided_tool_calls (
        call_id, turn_id, tool_name, raw_arguments, arguments_json, turn_sequence,
        status, result_json, result_sha256, started_at, finished_at
      ) VALUES (?, ?, ?, '{}', '{}', 1, 'completed', ?, ?, ?, ?)`)
        .run(callId, turnId, toolName, resultJson, sha(resultJson), now(), now());
    },
    resultCount: () => db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM btcc_guided_work_results").get()!.count,
    resultLink: (callId: string) => db.query<{ work_id: string; sequence: number }, [string]>(
      "SELECT work_id, sequence FROM btcc_guided_work_results WHERE tool_call_id = ?",
    ).get(callId),
    ledgerText: () => readFileSync(join(projectRoot, "ledger.jsonl"), "utf8"),
    close: () => db.close(),
  };
}

class ResultTestRuntime implements ProjectWorkRuntimeProjection {
  readonly originals = new Map<string, { turnId: string; messageId: string; content: string }>();
  constructor(
    private readonly db: Database,
    private readonly projection?: Pick<
      ProjectWorkRuntimeProjection,
      "locateCanonicalWorks" | "observeCanonicalWorks"
    >,
  ) {}
  locateCanonicalWorks(
    input: Parameters<ProjectWorkRuntimeProjection["locateCanonicalWorks"]>[0],
  ) {
    if (this.projection) return this.projection.locateCanonicalWorks(input);
    const concrete = new SqliteProjectWorkResultRuntime(this.db);
    return concrete.locateCanonicalWorks(input);
  }
  loadOriginalRequest(scope: { turnId: string }) {
    return Promise.resolve(this.originals.get(scope.turnId)!);
  }
  loadResultFacts() { return Promise.resolve([]); }
  operationRecordedAt(identity: ProjectWorkOperationIdentity) {
    const seconds = [...identity.id].reduce((sum, item) => sum + item.charCodeAt(0), 0) % 50;
    return Promise.resolve(new Date(Date.UTC(2026, 7, 25, 1, 0, seconds)).toISOString());
  }
  prepareDisposition(input: { command: RecordWorkDispositionCommand; current: DurableWorkView }) {
    return Promise.resolve({
      mode: "apply" as const,
      actionProgress: input.command.actionUpdates?.length
        ? applyWorkActionUpdates(input.current, input.command.actionUpdates)
        : input.current.actionProgress,
      evidenceSnapshot: input.command.evidenceRefs ?? [],
    });
  }
  captureWorkMaterial(input: { candidate: DurableWorkView }) {
    const materialFingerprint = dispositionMaterialFingerprint(input.candidate);
    return Promise.resolve({
      materialFingerprint,
      materialSnapshot: captureMaterialSnapshot(
        input.candidate,
        { effectWatermark: null, effectBlockers: [] },
        materialFingerprint,
      ),
    });
  }
  observeCanonicalWorks(
    input: Parameters<ProjectWorkRuntimeProjection["observeCanonicalWorks"]>[0],
  ) {
    if (this.projection) return this.projection.observeCanonicalWorks(input);
    this.db.transaction(() => {
      for (const { work } of input.works) {
        this.db.query(`INSERT INTO btcc_guided_works (
          work_id, session_id, scope_kind, scope_ref, origin_turn_id,
          origin_message_id, objective, status, current_plan_revision_id,
          ledger_project_id, canonical_head_sha256, created_at, updated_at
        ) VALUES (?, ?, 'project', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(work_id) DO UPDATE SET status=excluded.status,
          current_plan_revision_id=excluded.current_plan_revision_id,
          objective=excluded.objective,
          ledger_project_id=excluded.ledger_project_id,
          canonical_head_sha256=excluded.canonical_head_sha256,
          updated_at=excluded.updated_at`)
          .run(work.workId, work.sessionId,
            work.scope.kind === "project" ? work.scope.projectRef : work.sessionId,
            work.origin.turnId,
            work.origin.messageId, work.objective, work.status,
            work.currentPlan?.planRevisionId ?? null,
            input.ledgerProjectId, input.canonicalHeadSha256,
            work.createdAt, work.updatedAt);
      }
    }).immediate();
    return Promise.resolve();
  }
}

function insertTurn(db: Database, turnId: string) {
  db.query(`INSERT INTO btcc_turns (
    turn_id, session_id, inbox_id, trigger_key, original_message_id,
    original_message, admission_snapshot_ref, model_selection_json,
    context_json, semantic_state, revision, execution_fence
  ) VALUES (?, 'session-1', ?, ?, ?, 'request', 'snapshot', '{}', '{}', 'admitted', 1, 0)`)
    .run(turnId, `inbox-${turnId}`, `trigger-${turnId}`, `message-${turnId}`);
}
function sha(value: string) { return createHash("sha256").update(value).digest("hex"); }
function projectionState(db: Database) {
  return {
    works: db.query("SELECT * FROM btcc_guided_works ORDER BY work_id").all(),
    heads: db.query(`
      SELECT * FROM btcc_guided_work_session_heads ORDER BY session_id
    `).all(),
    bindings: db.query(`
      SELECT * FROM btcc_guided_turn_work_bindings ORDER BY binding_revision_id
    `).all(),
    results: db.query(`
      SELECT * FROM btcc_guided_work_results ORDER BY result_ref
    `).all(),
  };
}
function now() { return "2026-08-25T01:00:00.000Z"; }
function markdownBody(text: string) {
  const end = text.indexOf("\n---", 4);
  const value = text.slice(end + 4);
  return value.startsWith("\n\n") ? value.slice(2) : value.replace(/^\n/u, "");
}
