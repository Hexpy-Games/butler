import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGuidedEffectJournal } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { migrateBtccSchema } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema/migrate-schema.ts";
import type { DurableWorkView, DurableWorkService, WorkTurnScope } from "../../packages/butler-agent/src/agent/btcc/work/index.ts";
import { ordinaryGuidedEffectError, loadGuidedEffectWork } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-persistent-effect-resolution.ts";
import { createGuidedEffectService } from "../../packages/butler-agent/src/agent/btcc/effects/index.ts";
import { guidedToolDefinition } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-tool-definition.ts";
import { guidedWorkspaceEditInputSha256 } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-workspace-file-edit-adapter.ts";
import { workspaceFileEditBatchTarget } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-workspace-file-edit-batch.ts";
import { prepareGuidedWorkspaceFileEdit } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-workspace-file-edit-effect.ts";
import type { RegisteredEditFileInvocation } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-workspace-file-edit-contracts.ts";
import { createFileToolHandlers } from "../../packages/butler-agent/src/agent/tools/file-tools/index.ts";
import { validateJsonObjectSchema } from "../../packages/butler-agent/src/agent/tools/tool-support.ts";
import { editFileToolDefinition } from "../../packages/butler-agent/src/agent/tools/file-tools/edit_file/index.ts";

test("guided edit schema validates single and SHA-free batch model input", () => {
  const guided = guidedToolDefinition(editFileToolDefinition);
  expect(guided.description).not.toContain("expected_sha256");
  expect(JSON.stringify(guided.parameters)).not.toContain("expected_sha256");
  expect(
    validateJsonObjectSchema(
      {
        path: "one.txt",
        old_text: "one old\n",
        new_text: "one new\n",
      },
      guided.parameters,
    ),
  ).toEqual({ ok: true });
  expect(
    validateJsonObjectSchema(
      {
        edits: [
          { path: "one.txt", old_text: "one old\n", new_text: "one new\n" },
          { path: "two.txt", old_text: "two old\n", new_text: "two new\n" },
        ],
      },
      guided.parameters,
    ),
  ).toEqual({ ok: true });
  expect(
    validateJsonObjectSchema(
      {
        path: "one.txt",
        old_text: "one old\n",
        new_text: "one new\n",
        expected_sha256: "0".repeat(64),
      },
      guided.parameters,
    ),
  ).toMatchObject({ ok: false });
  expect(
    validateJsonObjectSchema(
      {
        edits: [
          {
            path: "one.txt",
            old_text: "one old\n",
            new_text: "one new\n",
            expected_sha256: "0".repeat(64),
          },
          { path: "two.txt", old_text: "two old\n", new_text: "two new\n" },
        ],
      },
      guided.parameters,
    ),
  ).toMatchObject({ ok: false });
});

test("ordinary effect failures keep causes without invented recovery and distinguish failed Work reads", async () => {
  expect(ordinaryGuidedEffectError("edit_file_no_change", "No files changed.", { changed: false })).toEqual({ ok: false, error: { code: "edit_file_no_change", message: "No files changed.", changed: false } });
  const scope = { turnId: "read-test" } as WorkTurnScope;
  const absent = { boundWorkForTurn: async () => null } as unknown as DurableWorkService;
  expect(await loadGuidedEffectWork(absent, scope)).toBeNull();
  const failure = new Error("durable Work storage is unavailable");
  const failed = { boundWorkForTurn: async () => { throw failure; } } as unknown as DurableWorkService;
  await expect(loadGuidedEffectWork(failed, scope)).rejects.toBe(failure);
});

test("guided batch prepares without mutation and dispatches one real registered edit_file call", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-batch-real-"));
  await writeFile(join(root, "one.txt"), "one old\n", "utf8");
  await writeFile(join(root, "two.txt"), "two old\n", "utf8");
  let dispatches = 0;
  try {
    const prepared = await prepareGuidedWorkspaceFileEdit({
      workspacePath: root,
      args: {
        edits: [
          { path: "one.txt", old_text: "one old\n", new_text: "one new\n" },
          { path: "two.txt", old_text: "two old\n", new_text: "two new\n" },
        ],
      },
      executeEditFile: registeredEditFile({
        workspacePath: root,
        onDispatch() {
          dispatches += 1;
        },
      }),
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.effect.target).toMatch(/^workspace:batch:[a-f0-9]{64}$/u);
    expect(prepared.effect.target).not.toContain("one.txt");
    expect(prepared.effect.target).not.toContain("two.txt");
    expect(await readFile(join(root, "one.txt"), "utf8")).toBe("one old\n");
    expect(await readFile(join(root, "two.txt"), "utf8")).toBe("two old\n");
    if (!("edits" in prepared.effect.input))
      throw new Error("Expected batch input");
    const reversedInput = prepared.effect.adapter.normalizeInput({
      edits: [...prepared.effect.input.edits].reverse(),
    });
    if (!("edits" in reversedInput))
      throw new Error("Expected reversed batch input");
    expect(workspaceFileEditBatchTarget(reversedInput)).not.toBe(
      prepared.effect.target,
    );
    expect(guidedWorkspaceEditInputSha256(reversedInput)).not.toBe(
      guidedWorkspaceEditInputSha256(prepared.effect.input),
    );
    expect(
      await prepared.effect.adapter.dispatch({
        normalizedTarget: prepared.effect.target,
        normalizedInput: prepared.effect.input,
        idempotencyKey: "guided-batch-real",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({
      status: "applied",
      result: { effect: "workspace_file_edit_batch", files: 2 },
    });
    expect(dispatches).toBe(1);
    expect(await readFile(join(root, "one.txt"), "utf8")).toBe("one new\n");
    expect(await readFile(join(root, "two.txt"), "utf8")).toBe("two new\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guided repeated-file edits share native ordering and durable aggregate recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-ordered-"));
  try {
    await writeFile(join(root, "one.txt"), "before\n", "utf8");
    const args = { edits: [
      { path: "one.txt", old_text: "before", new_text: "middle" },
      { path: "one.txt", old_text: "middle", new_text: "after" },
    ] };
    const executeEditFile = registeredEditFile({ workspacePath: root, onDispatch() {} });
    const prepared = await prepareGuidedWorkspaceFileEdit({ workspacePath: root, args, executeEditFile });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const { adapter, input, target } = prepared.effect;
    const recovery = { priorInputSha256: guidedWorkspaceEditInputSha256(input), priorRecoveryHint: adapter.recoveryHint!(input) };
    expect(await prepareGuidedWorkspaceFileEdit({ workspacePath: root, args, executeEditFile, ...recovery })).toMatchObject({ ok: true, effect: { input } });
    expect(await adapter.dispatch({ normalizedInput: input, normalizedTarget: target, idempotencyKey: "ordered", signal: new AbortController().signal })).toMatchObject({ status: "applied", result: { files: 1, bytes: 6 } });
    expect(await readFile(join(root, "one.txt"), "utf8")).toBe("after\n");
    expect(await prepareGuidedWorkspaceFileEdit({ workspacePath: root, args, executeEditFile, ...recovery })).toMatchObject({ ok: true, effect: { input } });
    expect(await adapter.reconcile({ normalizedInput: input, normalizedTarget: target, dispatchAttempts: 1, idempotencyKey: "ordered", signal: new AbortController().signal })).toMatchObject({ status: "applied", result: { files: 1 } });
    const mismatch = await prepareGuidedWorkspaceFileEdit({ workspacePath: root, args, executeEditFile });
    expect(mismatch).toMatchObject({ ok: false, error: { code: "old_text_mismatch" } });
    if (!mismatch.ok) {
      expect(mismatch.error.message).toContain("edits[0] (one.txt)");
      expect(mismatch.error.message).not.toContain("every file");
    }
    expect(await prepareGuidedWorkspaceFileEdit({ workspacePath: root, args: { path: "one.txt", old_text: "after", new_text: "after" }, executeEditFile })).toMatchObject({ ok: false, error: { code: "edit_file_no_change" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guided batch observes every target after an early observation failure", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "butler-guided-batch-observe-all-"),
  );
  await writeFile(join(root, "second.txt"), "second old\n", "utf8");
  try {
    const prepared = await prepareGuidedWorkspaceFileEdit({
      workspacePath: root,
      args: {
        edits: [
          {
            path: "missing.txt",
            old_text: "missing old\n",
            new_text: "missing new\n",
          },
          {
            path: "second.txt",
            old_text: "second old\n",
            new_text: "second new\n",
          },
        ],
      },
      executeEditFile: async () => ({ ok: true }),
    });
    expect(prepared).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await readFile(join(root, "second.txt"), "utf8")).toBe(
      "second old\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guided batch decoder accepts exactly one canonical form and owns nested SHA fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-batch-decode-"));
  await writeFile(join(root, "one.txt"), "one old\n", "utf8");
  await writeFile(join(root, "two.txt"), "two old\n", "utf8");
  const base = {
    path: "one.txt",
    old_text: "one old\n",
    new_text: "one new\n",
  };
  try {
    expect(
      await prepareGuidedWorkspaceFileEdit({
        workspacePath: root,
        args: {
          ...base,
          edits: [
            base,
            { path: "two.txt", old_text: "two old\n", new_text: "two new\n" },
          ],
        },
        executeEditFile: async () => ({ ok: true }),
      }),
    ).toMatchObject({ ok: false, error: { code: "edit_file_mixed_input" } });
    expect(
      await prepareGuidedWorkspaceFileEdit({
        workspacePath: root,
        args: {
          edits: [
            { ...base, expected_sha256: "0".repeat(64) },
            { path: "two.txt", old_text: "two old\n", new_text: "two new\n" },
          ],
        },
        executeEditFile: async () => ({ ok: true }),
      }),
    ).toMatchObject({ ok: false, error: { code: "edit_file_invalid_batch" } });
    expect(
      await prepareGuidedWorkspaceFileEdit({
        workspacePath: root,
        args: {
          changes: [
            base,
            { path: "two.txt", old_text: "two old\n", new_text: "two new\n" },
          ],
        },
        executeEditFile: async () => ({ ok: true }),
      }),
    ).toMatchObject({ ok: false, error: { code: "edit_file_invalid_input" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guided batch reconciliation distinguishes all-before, all-after, and mixed state", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-batch-reconcile-"));
  await writeFile(join(root, "one.txt"), "one old\n", "utf8");
  await writeFile(join(root, "two.txt"), "two old\n", "utf8");
  try {
    const prepared = await prepareGuidedWorkspaceFileEdit({
      workspacePath: root,
      args: {
        edits: [
          { path: "one.txt", old_text: "one old\n", new_text: "one new\n" },
          { path: "two.txt", old_text: "two old\n", new_text: "two new\n" },
        ],
      },
      executeEditFile: async () => ({ ok: true }),
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error.message);
    const reconcile = (dispatchAttempts: number) =>
      prepared.effect.adapter.reconcile({
        normalizedTarget: prepared.effect.target,
        normalizedInput: prepared.effect.input,
        idempotencyKey: "guided-batch-reconcile",
        signal: new AbortController().signal,
        dispatchAttempts,
      });
    expect(await reconcile(0)).toEqual({ status: "not_applied" });
    await writeFile(join(root, "one.txt"), "one new\n", "utf8");
    await writeFile(join(root, "two.txt"), "two new\n", "utf8");
    expect(await reconcile(0)).toEqual({ status: "not_applied" });
    expect((await reconcile(1)).status).toBe("applied");
    await writeFile(join(root, "two.txt"), "unrelated\n", "utf8");
    expect((await reconcile(1)).status).toBe("uncertain");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guided batch partial_apply stays terminally uncertain after external completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-batch-partial-"));
  await writeFile(join(root, "one.txt"), "one old\n", "utf8");
  await writeFile(join(root, "two.txt"), "two old\n", "utf8");
  let dispatches = 0;
  const work = reviewedFileWork("workspace:batch-intent");
  work.currentPlan!.actions[0]!.effect = {
    capability: "edit_file",
    target: "workspace:batch-intent",
  };
  let db: Database | undefined;
  try {
    const prepared = await prepareGuidedWorkspaceFileEdit({
      workspacePath: root,
      args: {
        edits: [
          { path: "one.txt", old_text: "one old\n", new_text: "one new\n" },
          { path: "two.txt", old_text: "two old\n", new_text: "two new\n" },
        ],
      },
      executeEditFile: async () => {
        dispatches += 1;
        return { ok: false, error: "partial_apply" };
      },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error.message);
    db = openEffectDatabase(join(root, "effects.sqlite"));
    const service = createGuidedEffectService(
      new SqliteGuidedEffectJournal(db),
    );
    const execute = () =>
      service.execute({
        work,
        accessMode: "full_access" as const,
        occurrenceId: "guided-batch-partial",
        signal: new AbortController().signal,
        target: prepared.effect.target,
        input: prepared.effect.input,
        adapter: prepared.effect.adapter,
      });
    expect(await execute()).toMatchObject({ ok: false, status: "uncertain" });
    expect(await execute()).toMatchObject({ ok: false, status: "uncertain" });
    expect(dispatches).toBe(1);
    await writeFile(join(root, "one.txt"), "one new\n", "utf8");
    await writeFile(join(root, "two.txt"), "two new\n", "utf8");
    expect(await execute()).toMatchObject({ ok: false, status: "uncertain" });
    expect(dispatches).toBe(1);
  } finally {
    db?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("after-dispatch-marker crash resumes the same batch journal occurrence", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-batch-marker-"));
  await writeFile(join(root, "one.txt"), "one old\n", "utf8");
  await writeFile(join(root, "two.txt"), "two old\n", "utf8");
  const work = reviewedFileWork("workspace:batch-intent");
  work.currentPlan!.actions[0]!.effect = {
    capability: "edit_file",
    target: "workspace:batch-intent",
  };
  let markerDb: Database | undefined;
  let dispatches = 0;
  try {
    const prepared = await prepareGuidedWorkspaceFileEdit({
      workspacePath: root,
      args: {
        edits: [
          { path: "one.txt", old_text: "one old\n", new_text: "one new\n" },
          { path: "two.txt", old_text: "two old\n", new_text: "two new\n" },
        ],
      },
      executeEditFile: registeredEditFile({
        workspacePath: root,
        onDispatch() {
          dispatches += 1;
        },
      }),
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error.message);
    markerDb = openEffectDatabase(join(root, "marker.sqlite"));
    const journal = new SqliteGuidedEffectJournal(markerDb);
    const crashing = createGuidedEffectService(journal, {
      faultHook(point) {
        if (point === "after_dispatch_marker")
          throw new Error("crash after marker");
      },
    });
    const execute = (service: ReturnType<typeof createGuidedEffectService>) =>
      service.execute({
        work,
        accessMode: "full_access" as const,
        occurrenceId: "guided-batch-marker",
        signal: new AbortController().signal,
        target: prepared.effect.target,
        input: prepared.effect.input,
        adapter: prepared.effect.adapter,
      });
    await expect(execute(crashing)).rejects.toThrow("crash after marker");
    const before = journal.listForWork(work.workId)[0];
    expect(before).toMatchObject({
      status: "dispatching",
      dispatchAttempts: 1,
    });
    expect(await execute(createGuidedEffectService(journal))).toMatchObject({
      ok: true,
      status: "applied",
    });
    const after = journal.listForWork(work.workId)[0];
    expect(after?.effectId).toBe(before?.effectId);
    expect(after?.dispatchAttempts).toBe(2);
    expect(dispatches).toBe(1);
  } finally {
    markerDb?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("guided batch recovery payload hydrates across restart while legacy single hints remain readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-batch-hydration-"));
  const dbPath = join(root, "effects.sqlite");
  let db: Database | undefined;
  try {
    db = openEffectDatabase(dbPath);
    const journal = new SqliteGuidedEffectJournal(db);
    const hash = (value: string) => sha256(value);
    const base = {
      receiptId: "batch-r",
      idempotencyKey: "batch-i",
      identitySha256: "batch-id",
      requestSha256: "batch-req",
      inputSha256: "batch-input",
      targetSha256: "batch-target",
      workId: "batch-work",
      planRevisionId: "batch-plan",
      actionKey: "accepted-plan",
      capability: "edit_file",
      sanitizedTarget: `workspace:batch:${"a".repeat(64)}`,
    } as const;
    expect(
      journal.prepare(
        { ...base, effectId: "batch-effect" },
        {
          capability: "edit_file",
          entries: [
            {
              path: "one.txt",
              startLine: 1,
              beforeSha256: hash("one old\n"),
              afterSha256: hash("one new\n"),
            },
            {
              path: "two.txt",
              startLine: 1,
              beforeSha256: hash("two old\n"),
              afterSha256: hash("two new\n"),
            },
          ],
        },
      ).ok,
    ).toBe(true);
    expect(
      journal.prepare(
        {
          ...base,
          effectId: "single-effect",
          receiptId: "single-r",
          idempotencyKey: "single-i",
          identitySha256: "single-id",
          inputSha256: "single-input",
          targetSha256: "single-target",
          sanitizedTarget: "workspace:one.txt",
        },
        {
          capability: "edit_file",
          startLine: 1,
          beforeSha256: hash("one old\n"),
          afterSha256: hash("one new\n"),
        },
      ).ok,
    ).toBe(true);
    expect(() =>
      journal.prepare(
        {
          ...base,
          effectId: "invalid-effect",
          receiptId: "invalid-r",
          idempotencyKey: "invalid-i",
          identitySha256: "invalid-id",
          inputSha256: "invalid-input",
          targetSha256: "invalid-target",
          sanitizedTarget: `workspace:batch:${"b".repeat(64)}`,
        },
        {
          capability: "edit_file",
          entries: [
            {
              path: "/private/absolute.txt",
              startLine: 1,
              beforeSha256: hash("one old\n"),
              afterSha256: hash("one new\n"),
            },
            {
              path: "two.txt",
              startLine: 1,
              beforeSha256: hash("two old\n"),
              afterSha256: hash("two new\n"),
            },
          ],
        },
      ),
    ).toThrow();
    expect(journal.find("invalid-effect")).toBeNull();
    expect(
      journal.prepare({
        ...base,
        effectId: "malformed-effect",
        receiptId: "malformed-r",
        idempotencyKey: "malformed-i",
        identitySha256: "malformed-id",
        inputSha256: "malformed-input",
        targetSha256: "malformed-target",
        sanitizedTarget: `workspace:batch:${"c".repeat(64)}`,
      }).ok,
    ).toBe(true);
    db.query(
      "INSERT INTO btcc_guided_effect_recovery_payloads (effect_id, capability, payload_json) VALUES (?, ?, ?)",
    ).run("malformed-effect", "edit_file", "[]");
    expect(() => journal.find("malformed-effect")).toThrow();
    db.close();
    db = undefined;
    db = openEffectDatabase(dbPath);
    const resumed = new SqliteGuidedEffectJournal(db);
    expect(resumed.find("batch-effect")?.recoveryHint).toMatchObject({
      capability: "edit_file",
      entries: [{ path: "one.txt" }, { path: "two.txt" }],
    });
    expect(resumed.find("single-effect")?.recoveryHint).toMatchObject({
      capability: "edit_file",
      startLine: 1,
    });
    expect(
      db
        .query<
          { count: number },
          [string]
        >("SELECT COUNT(*) AS count FROM btcc_guided_effect_recovery_payloads WHERE effect_id = ?")
        .get("batch-effect")?.count,
    ).toBe(1);
    const legacyDb = openEffectDatabase(join(root, "legacy.sqlite"));
    const legacyJournal = new SqliteGuidedEffectJournal(legacyDb);
    expect(
      legacyJournal.prepare(
        {
          ...base,
          effectId: "legacy-effect",
          receiptId: "legacy-r",
          idempotencyKey: "legacy-i",
          identitySha256: "legacy-id",
          inputSha256: "legacy-input",
          targetSha256: "legacy-target",
          sanitizedTarget: "workspace:one.txt",
        },
        {
          capability: "edit_file",
          startLine: 1,
          beforeSha256: hash("one old\n"),
          afterSha256: hash("one new\n"),
        },
      ).ok,
    ).toBe(true);
    legacyDb.query("DROP TABLE btcc_guided_effect_recovery_payloads").run();
    migrateBtccSchema(legacyDb);
    expect(
      new SqliteGuidedEffectJournal(legacyDb).find("legacy-effect")
        ?.recoveryHint,
    ).toMatchObject({ capability: "edit_file", startLine: 1 });
    legacyDb.close();
  } finally {
    db?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("guided edit blocker classification uses path-set overlap for single and batch inputs", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "butler-guided-edit-blocker-batch-"),
  );
  await writeFile(join(root, "one.txt"), "one old\n", "utf8");
  await writeFile(join(root, "two.txt"), "two old\n", "utf8");
  try {
    const prepared = await prepareGuidedWorkspaceFileEdit({
      workspacePath: root,
      args: {
        edits: [
          { path: "one.txt", old_text: "one old\n", new_text: "one new\n" },
          { path: "two.txt", old_text: "two old\n", new_text: "two new\n" },
        ],
      },
      executeEditFile: async () => ({ ok: true }),
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error.message);
    if (!("edits" in prepared.effect.input))
      throw new Error("Expected batch input");
    const single = prepared.effect.input.edits[0]!;
    const classify = (
      blockerTarget: string,
      blockerInput: Record<string, unknown>,
      normalizedTarget = prepared.effect.target,
      normalizedInput = prepared.effect.input,
    ) =>
      prepared.effect.adapter.classifyEffectBlocker?.({
        blockerCapability: "edit_file",
        blockerTarget,
        blockerInput,
        normalizedTarget,
        normalizedInput,
      });
    expect(await classify("workspace:one.txt", single)).toBe("overlapping");
    expect(
      await classify(
        prepared.effect.target,
        prepared.effect.input as Record<string, unknown>,
      ),
    ).toBe("equivalent");
    expect(
      await classify("workspace:other.txt", { ...single, path: "other.txt" }),
    ).toBe("unrelated");
    expect(await classify("workspace:other.txt", single)).toBe("ambiguous");
    expect(
      await classify(
        `workspace:batch:${"f".repeat(64)}`,
        prepared.effect.input as Record<string, unknown>,
        "workspace:batch:not-a-sha",
      ),
    ).toBe("ambiguous");
    const singlePrepared = await prepareGuidedWorkspaceFileEdit({
      workspacePath: root,
      args: { path: "one.txt", old_text: "one old\n", new_text: "one new\n" },
      executeEditFile: async () => ({ ok: true }),
    });
    expect(singlePrepared.ok).toBe(true);
    if (!singlePrepared.ok) throw new Error(singlePrepared.error.message);
    expect(
      await singlePrepared.effect.adapter.classifyEffectBlocker?.({
        blockerCapability: "edit_file",
        blockerTarget: prepared.effect.target,
        blockerInput: prepared.effect.input as Record<string, unknown>,
        normalizedTarget: singlePrepared.effect.target,
        normalizedInput: singlePrepared.effect.input,
      }),
    ).toBe("overlapping");
    expect(
      await singlePrepared.effect.adapter.classifyEffectBlocker?.({
        blockerCapability: "edit_file",
        blockerTarget: singlePrepared.effect.target,
        blockerInput: single,
        normalizedTarget: "workspace:wrong.txt",
        normalizedInput: singlePrepared.effect.input,
      }),
    ).toBe("ambiguous");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function registeredEditFile(input: {
  workspacePath: string;
  onDispatch(result: unknown): void;
}) {
  const handlers = createFileToolHandlers({
    workspacePath: input.workspacePath,
  });
  const editFile = handlers.edit_file;
  if (!editFile) throw new Error("registered edit_file handler is missing");
  return async (args: RegisteredEditFileInvocation): Promise<unknown> => {
    const result = await editFile({
      name: "edit_file",
      args,
      rawArguments: JSON.stringify(args),
    });
    input.onDispatch(result);
    return result;
  };
}

function openEffectDatabase(path: string): Database {
  const db = new Database(path);
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  return db;
}

function reviewedFileWork(target: string): DurableWorkView {
  const planRevisionId = "guided-plan-file-1";
  return {
    workId: "guided-work-file-1",
    sessionId: "session-file-1",
    scope: { kind: "session", sessionId: "session-file-1" },
    origin: { turnId: "turn-file-1", messageId: "message-file-1" },
    objective: "Write the summary file",
    status: "open",
    currentStage: "execution",
    allowedNextStages: ["review"],
    actionProgress: [{ actionKey: "write-summary", status: "active" }],
    currentPlan: {
      planRevisionId,
      revision: 1,
      objective: "Write the requested summary",
      actions: [
        {
          actionKey: "write-summary",
          description: "Write the requested summary",
          dependencyKeys: [],
          effect: { capability: "write_file", target },
        },
      ],
      checks: ["Read the final file"],
      originTurnId: "turn-file-1",
      createdAt: "2026-07-31T00:00:00.000Z",
    },
    latestPlanReview: {
      reviewRevisionId: "guided-plan-review-file-1",
      revision: 1,
      subject: "plan",
      verdict: "accept",
      summary: "The exact workspace target is safe.",
      corrections: [],
      boundPlanRevisionId: planRevisionId,
      boundResultRefs: [],
      originTurnId: "turn-file-1",
      createdAt: "2026-07-31T00:00:01.000Z",
    },
    resultRefs: [],
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:01.000Z",
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
