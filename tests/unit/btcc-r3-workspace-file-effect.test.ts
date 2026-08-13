import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGuidedEffectJournal } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import type { DurableWorkView } from
  "../../packages/butler-agent/src/agent/btcc/work/index.ts";
import {
  createGuidedEffectService,
  type GuidedEffectFaultHook,
} from "../../packages/butler-agent/src/agent/btcc/effects/index.ts";
import {
  createGuidedWorkspaceFileEffectAdapter,
  type GuidedWorkspaceFileInput,
  workspaceFileEffectTarget,
} from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-workspace-file-effect.ts";
import { guidedWorkspaceEditInputSha256 } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-workspace-file-edit-adapter.ts";
import { prepareGuidedWorkspaceFileEdit } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-workspace-file-edit-effect.ts";
import { createFileToolHandlers } from
  "../../packages/butler-agent/src/agent/tools/file-tools/index.ts";
import { locateExactText } from
  "../../packages/butler-agent/src/agent/tools/file-tools/edit_file/exact-text-locator.ts";

test("workspace file adapter keeps target syntax simple and preserves file guards", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-file-"));
  const butlerData = join(root, "butler-data");
  const protectedFile = join(
    butlerData,
    "project-ledger",
    "projects",
    "demo",
    "specs",
    "feature.md",
  );
  await mkdir(join(protectedFile, ".."), { recursive: true });

  let dispatches = 0;
  const adapter = createGuidedWorkspaceFileEffectAdapter({
    workspacePath: root,
    butlerData,
    executeWriteFile: async () => {
      dispatches += 1;
      return { ok: true };
    },
  });
  try {
    expect(adapter.capability).toBe("write_file");
    expect(workspaceFileEffectTarget("./reports//summary.md"))
      .toBe("workspace:reports/summary.md");
    expect(adapter.normalizeTarget("workspace:./reports/summary.md"))
      .toBe("workspace:reports/summary.md");
    expect(adapter.normalizeInput({
      path: join(root, "report.md"),
      content: "private",
    })).toMatchObject({ path: "report.md" });
    expect(() => adapter.normalizeInput({
      path: join(tmpdir(), "outside-report.md"),
      content: "private",
    })).toThrow("inside the workspace");
    expect(() => adapter.normalizeInput({
      path: "reports/summary.md",
      content: "safe",
      overwrite: false,
    })).toThrow("rejects unknown input: overwrite");
    expect(() => adapter.normalizeInput({
      path: "reports/summary.md",
      content: "safe",
      expected_sha256: "0".repeat(64),
    })).toThrow("rejects unknown input: expected_sha256");

    const protectedInput = adapter.normalizeInput({
      path: "butler-data/project-ledger/projects/demo/specs/feature.md",
      content: "must not write",
      create_parents: false,
    });
    const protectedResult = await adapter.dispatch({
      normalizedTarget: workspaceFileEffectTarget(protectedInput.path),
      normalizedInput: protectedInput,
      idempotencyKey: "runtime-owned",
      signal: new AbortController().signal,
    });
    expect(protectedResult).toMatchObject({
      status: "not_applied",
      error: { code: "protected_path" },
    });
    expect(dispatches).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one accepted high-level Plan authorizes distinct contained file targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-file-plan-"));
  const workspacePath = join(root, "workspace");
  const butlerData = join(root, "butler-data");
  const db = openEffectDatabase(join(root, "effects.sqlite"));
  await mkdir(workspacePath, { recursive: true });

  let registeredDispatches = 0;
  const adapter = createGuidedWorkspaceFileEffectAdapter({
    workspacePath,
    butlerData,
    executeWriteFile: registeredWriteFile({
      workspacePath,
      butlerData,
      onDispatch() {
        registeredDispatches += 1;
      },
    }),
  });
  const work = reviewedFileWork("workspace:landing-page-source-files");
  work.currentPlan!.actions[0]!.effect = {
    capability: "workspace mutation",
    target: "workspace:landing-page-source-files",
  };
  const firstInput: GuidedWorkspaceFileInput = {
    path: "index.html",
    content: "<main>Butler</main>\n",
    create_parents: false,
  };
  const secondInput: GuidedWorkspaceFileInput = {
    path: "src/app.js",
    content: "export const ready = true;\n",
    create_parents: true,
  };
  const service = createGuidedEffectService(new SqliteGuidedEffectJournal(db));

  try {
    expect(adapter.reviewedPlanBinding).toBe("accepted_plan");
    const unreviewedWork = { ...work };
    delete unreviewedWork.latestPlanReview;
    expect(await service.execute({
      work: unreviewedWork,
      accessMode: "full_access",
      occurrenceId: "tool-call-file-1",
      signal: new AbortController().signal,
      target: workspaceFileEffectTarget(firstInput.path),
      input: firstInput,
      adapter,
    })).toMatchObject({
      ok: false,
      error: { code: "effect_plan_review_required" },
    });
    const noEffectWork: DurableWorkView = {
      ...work,
      currentPlan: {
        ...work.currentPlan!,
        actions: work.currentPlan!.actions.map(({ effect: _, ...action }) =>
          action,
        ),
      },
    };
    expect(await service.execute({
      work: noEffectWork,
      accessMode: "full_access",
      occurrenceId: "tool-call-file-1",
      signal: new AbortController().signal,
      target: workspaceFileEffectTarget(firstInput.path),
      input: firstInput,
      adapter,
    })).toMatchObject({
      ok: false,
      error: { code: "effect_action_not_found" },
    });
    expect(registeredDispatches).toBe(0);
    const first = await service.execute({
      work,
      accessMode: "full_access",
      occurrenceId: "tool-call-file-1",
      signal: new AbortController().signal,
      target: workspaceFileEffectTarget(firstInput.path),
      input: firstInput,
      adapter,
    });
    const conflictingTargetReuse = await service.execute({
      work,
      accessMode: "full_access",
      occurrenceId: "tool-call-file-1",
      signal: new AbortController().signal,
      target: workspaceFileEffectTarget(secondInput.path),
      input: secondInput,
      adapter,
    });
    const second = await service.execute({
      work,
      accessMode: "full_access",
      occurrenceId: "tool-call-file-2",
      signal: new AbortController().signal,
      target: workspaceFileEffectTarget(secondInput.path),
      input: secondInput,
      adapter,
    });

    expect(first).toMatchObject({
      ok: true,
      status: "applied",
      receipt: {
        actionKey: "accepted-plan",
        sanitizedTarget: "workspace:index.html",
      },
    });
    expect(conflictingTargetReuse).toMatchObject({
      ok: false,
      error: { code: "effect_identity_conflict" },
    });
    expect(second).toMatchObject({
      ok: true,
      status: "applied",
      receipt: {
        actionKey: "accepted-plan",
        sanitizedTarget: "workspace:src/app.js",
      },
    });
    if (!first.ok || !second.ok) {
      throw new Error("Expected both contained workspace writes to apply");
    }
    expect(first.receipt.effectId).not.toBe(second.receipt.effectId);
    expect(first.receipt.targetSha256).not.toBe(second.receipt.targetSha256);
    expect(first.receipt.identitySha256).not.toBe(
      second.receipt.identitySha256,
    );
    expect(registeredDispatches).toBe(2);
    expect(await readFile(join(workspacePath, firstInput.path), "utf8"))
      .toBe(firstInput.content);
    expect(await readFile(join(workspacePath, secondInput.path), "utf8"))
      .toBe(secondInput.content);

    expect(await service.execute({
      work,
      accessMode: "full_access",
      occurrenceId: "tool-call-file-1",
      signal: new AbortController().signal,
      target: workspaceFileEffectTarget(firstInput.path),
      input: firstInput,
      adapter,
    })).toMatchObject({ ok: true, status: "applied", replayed: true });
    expect(registeredDispatches).toBe(2);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("one accepted high-level Plan authorizes successive corrections to the same file", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-file-correction-"));
  const workspacePath = join(root, "workspace");
  const butlerData = join(root, "butler-data");
  const db = openEffectDatabase(join(root, "effects.sqlite"));
  await mkdir(workspacePath, { recursive: true });

  let registeredDispatches = 0;
  const adapter = createGuidedWorkspaceFileEffectAdapter({
    workspacePath,
    butlerData,
    executeWriteFile: registeredWriteFile({
      workspacePath,
      butlerData,
      onDispatch() {
        registeredDispatches += 1;
      },
    }),
  });
  const work = reviewedFileWork("workspace:landing-page-source-files");
  work.currentPlan!.actions[0]!.effect = {
    capability: "workspace mutation",
    target: "workspace:landing-page-source-files",
  };
  const target = workspaceFileEffectTarget("styles.css");
  const initial: GuidedWorkspaceFileInput = {
    path: "styles.css",
    content: "main { overflow-x: auto; }\n",
    create_parents: false,
  };
  const correction: GuidedWorkspaceFileInput = {
    ...initial,
    content: "main { overflow-x: hidden; }\n",
  };
  const revert: GuidedWorkspaceFileInput = { ...initial };
  await writeFile(
    join(workspacePath, initial.path),
    "main { overflow-x: scroll; }\n",
    "utf8",
  );
  const service = createGuidedEffectService(new SqliteGuidedEffectJournal(db));

  try {
    const first = await service.execute({
      work,
      accessMode: "full_access",
      occurrenceId: "tool-call-style-1",
      signal: new AbortController().signal,
      target,
      input: initial,
      adapter,
    });
    const conflictingReuse = await service.execute({
      work,
      accessMode: "full_access",
      occurrenceId: "tool-call-style-1",
      signal: new AbortController().signal,
      target,
      input: correction,
      adapter,
    });
    const second = await service.execute({
      work,
      accessMode: "full_access",
      occurrenceId: "tool-call-style-2",
      signal: new AbortController().signal,
      target,
      input: correction,
      adapter,
    });
    const third = await service.execute({
      work,
      accessMode: "full_access",
      occurrenceId: "tool-call-style-3",
      signal: new AbortController().signal,
      target,
      input: revert,
      adapter,
    });
    const replay = await service.execute({
      work,
      accessMode: "full_access",
      occurrenceId: "tool-call-style-3",
      signal: new AbortController().signal,
      target,
      input: revert,
      adapter,
    });

    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(conflictingReuse).toMatchObject({
      ok: false,
      error: { code: "effect_identity_conflict" },
    });
    expect(second).toMatchObject({ ok: true, replayed: false });
    expect(third).toMatchObject({ ok: true, replayed: false });
    expect(replay).toMatchObject({ ok: true, replayed: true });
    if (!first.ok || !second.ok || !third.ok) {
      throw new Error("Expected all accepted-Plan writes to apply");
    }
    expect(first.receipt.effectId).not.toBe(second.receipt.effectId);
    expect(first.receipt.effectId).not.toBe(third.receipt.effectId);
    expect(first.receipt.targetSha256).toBe(second.receipt.targetSha256);
    expect(first.receipt.inputSha256).toBe(third.receipt.inputSha256);
    expect(first.receipt.inputSha256).not.toBe(second.receipt.inputSha256);
    expect(registeredDispatches).toBe(3);
    expect(await readFile(join(workspacePath, correction.path), "utf8"))
      .toBe(revert.content);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace file adapter derives replacement mode and enforces its observed preimage hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-file-runtime-hash-"));
  const original = "before\n";
  await writeFile(join(root, "existing.md"), original, "utf8");
  const writeFileHandler = createFileToolHandlers({ workspacePath: root }).write_file;
  if (!writeFileHandler) throw new Error("registered write_file handler is missing");
  let registeredInput: Record<string, unknown> | null = null;
  const adapter = createGuidedWorkspaceFileEffectAdapter({
    workspacePath: root,
    async executeWriteFile(args) {
      registeredInput = args;
      return await writeFileHandler({
        name: "write_file",
        args,
        rawArguments: JSON.stringify(args),
      });
    },
  });
  try {
    const normalized = adapter.normalizeInput({
      path: "existing.md",
      content: "after\n",
    });
    expect(await adapter.dispatch({
      normalizedTarget: workspaceFileEffectTarget(normalized.path),
      normalizedInput: normalized,
      idempotencyKey: "runtime-hash",
      signal: new AbortController().signal,
    })).toMatchObject({ status: "applied" });
    expect(registeredInput as unknown).toEqual({
      path: "existing.md",
      content: "after\n",
      overwrite: true,
      create_parents: false,
      expected_sha256: sha256(original),
    });
    expect(await readFile(join(root, "existing.md"), "utf8")).toBe("after\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace file adapter derives create mode for a missing target", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-file-create-mode-"));
  const writeFileHandler = createFileToolHandlers({ workspacePath: root }).write_file;
  if (!writeFileHandler) throw new Error("registered write_file handler is missing");
  let registeredInput: Record<string, unknown> | null = null;
  const adapter = createGuidedWorkspaceFileEffectAdapter({
    workspacePath: root,
    async executeWriteFile(args) {
      registeredInput = args;
      return await writeFileHandler({
        name: "write_file",
        args,
        rawArguments: JSON.stringify(args),
      });
    },
  });
  try {
    const normalized = adapter.normalizeInput({
      path: "nested/new.md",
      content: "created\n",
      create_parents: true,
    });
    expect(await adapter.dispatch({
      normalizedTarget: workspaceFileEffectTarget(normalized.path),
      normalizedInput: normalized,
      idempotencyKey: "runtime-create-mode",
      signal: new AbortController().signal,
    })).toMatchObject({ status: "applied" });
    expect(registeredInput as unknown).toEqual({
      path: "nested/new.md",
      content: "created\n",
      overwrite: false,
      create_parents: true,
    });
    expect(await readFile(join(root, "nested/new.md"), "utf8")).toBe("created\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace file adapter refuses a replacement when the observed preimage races", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-file-replace-race-"));
  const path = join(root, "existing.md");
  const original = "before\n";
  const concurrent = "concurrent\n";
  await writeFile(path, original, "utf8");
  const writeFileHandler = createFileToolHandlers({ workspacePath: root }).write_file;
  if (!writeFileHandler) throw new Error("registered write_file handler is missing");
  let registeredInput: Record<string, unknown> | null = null;
  const adapter = createGuidedWorkspaceFileEffectAdapter({
    workspacePath: root,
    async executeWriteFile(args) {
      registeredInput = args;
      await writeFile(path, concurrent, "utf8");
      return await writeFileHandler({
        name: "write_file",
        args,
        rawArguments: JSON.stringify(args),
      });
    },
  });
  try {
    const normalized = adapter.normalizeInput({
      path: "existing.md",
      content: "after\n",
    });
    expect(await adapter.dispatch({
      normalizedTarget: workspaceFileEffectTarget(normalized.path),
      normalizedInput: normalized,
      idempotencyKey: "runtime-replace-race",
      signal: new AbortController().signal,
    })).toMatchObject({
      status: "not_applied",
      error: { code: "expected_sha256_mismatch" },
    });
    expect(registeredInput as unknown).toEqual({
      path: "existing.md",
      content: "after\n",
      overwrite: true,
      create_parents: false,
      expected_sha256: sha256(original),
    });
    expect(await readFile(path, "utf8")).toBe(concurrent);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guided edit prepares a small exact replacement with a runtime-owned stale-write guard", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-edit-cas-"));
  const original = "alpha\nbeta\ngamma\n";
  await writeFile(join(root, "notes.txt"), original, "utf8");
  let registeredDispatches = 0;
  const prepared = await prepareGuidedWorkspaceFileEdit({
    args: {
      path: "notes.txt",
      start_line: 2,
      old_text: "beta\n",
      new_text: "better\n",
      expected_sha256: "0".repeat(64),
    },
    workspacePath: root,
    executeEditFile: registeredEditFile({
      workspacePath: root,
      butlerData: join(root, "butler-data"),
      onDispatch() {
        registeredDispatches += 1;
      },
    }),
  });
  try {
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.effect.input).toMatchObject({
      path: "notes.txt",
      start_line: 2,
      old_text: "beta\n",
      new_text: "better\n",
      before_sha256: sha256(original),
      after_sha256: sha256("alpha\nbetter\ngamma\n"),
    });

    await writeFile(join(root, "notes.txt"), "concurrent change\n", "utf8");
    expect(await prepared.effect.adapter.dispatch({
      normalizedTarget: prepared.effect.target,
      normalizedInput: prepared.effect.input,
      idempotencyKey: "edit-cas",
      signal: new AbortController().signal,
    })).toMatchObject({
      status: "not_applied",
      error: { code: "expected_sha256_mismatch" },
    });
    expect(registeredDispatches).toBe(0);
    expect(await readFile(join(root, "notes.txt"), "utf8"))
      .toBe("concurrent change\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guided edit resolves a unique exact text after a stale line shift and accepts no hint", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-edit-stale-hint-"));
  const original = "inserted\nalpha\nbeta\ngamma\n";
  await writeFile(join(root, "notes.txt"), original, "utf8");
  let registeredDispatches = 0;
  try {
    const prepared = await prepareGuidedWorkspaceFileEdit({
      args: {
        path: "notes.txt",
        start_line: 2,
        old_text: "beta\n",
        new_text: "better\n",
      },
      workspacePath: root,
      executeEditFile: registeredEditFile({
        workspacePath: root,
        butlerData: join(root, "butler-data"),
        onDispatch() {
          registeredDispatches += 1;
        },
      }),
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.effect.input).toMatchObject({
      start_line: 3,
      old_text: "beta\n",
      after_sha256: sha256("inserted\nalpha\nbetter\ngamma\n"),
    });
    expect(await prepared.effect.adapter.dispatch({
      normalizedTarget: prepared.effect.target,
      normalizedInput: prepared.effect.input,
      idempotencyKey: "edit-stale-hint",
      signal: new AbortController().signal,
    })).toMatchObject({ status: "applied" });
    expect(registeredDispatches).toBe(1);
    expect(await readFile(join(root, "notes.txt"), "utf8"))
      .toBe("inserted\nalpha\nbetter\ngamma\n");

    const noHint = await prepareGuidedWorkspaceFileEdit({
      args: {
        path: "notes.txt",
        old_text: "better\n",
        new_text: "best\n",
      },
      workspacePath: root,
      executeEditFile: async () => ({ ok: true }),
    });
    expect(noHint.ok).toBe(true);
    if (!noHint.ok) throw new Error(noHint.error.message);
    if ("edits" in noHint.effect.input) throw new Error("expected single edit");
    expect(noHint.effect.input.start_line).toBe(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guided edit rejects multiple unresolved exact-text occurrences", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-edit-ambiguous-"));
  await writeFile(join(root, "notes.txt"), "alpha\nbeta beta\ngamma\n", "utf8");
  try {
    expect(await prepareGuidedWorkspaceFileEdit({
      args: {
        path: "notes.txt",
        start_line: 2,
        old_text: "beta",
        new_text: "changed",
      },
      workspacePath: root,
      executeEditFile: async () => {
        throw new Error("ambiguous edits must not dispatch");
      },
    })).toMatchObject({
      ok: false,
      error: { code: "old_text_ambiguous" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exact-text locator uses actual occurrence start lines and global uniqueness without a hint", () => {
  expect(locateExactText({
    text: "prefix old\nother old\n",
    oldText: "old",
    startLine: 1,
  })).toEqual({
    ok: true,
    value: { offset: 7, startLine: 1 },
  });
  expect(locateExactText({
    text: "prefix old and old\nother\n",
    oldText: "old",
    startLine: 1,
  })).toMatchObject({
    ok: false,
    error: "old_text_ambiguous",
    occurrenceCount: 2,
  });
  expect(locateExactText({
    text: "prefix old\nother old\n",
    oldText: "old",
  })).toMatchObject({
    ok: false,
    error: "old_text_ambiguous",
    occurrenceCount: 2,
  });
});

test("legacy edit recovery requires one current before-state candidate and derives its hint", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-edit-legacy-hint-"));
  const original = "prefix\nold\nend\n";
  await writeFile(join(root, "notes.txt"), original, "utf8");
  try {
    const first = await prepareGuidedWorkspaceFileEdit({
      args: {
        path: "notes.txt",
        start_line: 2,
        old_text: "old\n",
        new_text: "new\n",
      },
      workspacePath: root,
      executeEditFile: async () => ({ ok: true }),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);

    const legacy = await prepareGuidedWorkspaceFileEdit({
      args: {
        path: "notes.txt",
        start_line: 2,
        old_text: "old\n",
        new_text: "new\n",
      },
      workspacePath: root,
      priorInputSha256: guidedWorkspaceEditInputSha256(first.effect.input),
      executeEditFile: async () => ({ ok: true }),
    });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) throw new Error(legacy.error.message);
    expect(legacy.effect.input).toEqual(first.effect.input);
    expect(legacy.effect.adapter.recoveryHint?.(legacy.effect.input)).toMatchObject({
      capability: "edit_file",
      startLine: 2,
      beforeSha256: sha256(original),
      afterSha256: sha256("prefix\nnew\nend\n"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy edit recovery uses durable input identity to select one duplicate before-state candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-edit-legacy-ambiguous-"));
  await writeFile(join(root, "notes.txt"), "old\nmiddle\nold\n", "utf8");
  try {
    const first = await prepareGuidedWorkspaceFileEdit({
      args: {
        path: "notes.txt",
        start_line: 3,
        old_text: "old\n",
        new_text: "new\n",
      },
      workspacePath: root,
      executeEditFile: async () => ({ ok: true }),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);

    const legacy = await prepareGuidedWorkspaceFileEdit({
      args: {
        path: "notes.txt",
        start_line: 99,
        old_text: "old\n",
        new_text: "new\n",
      },
      workspacePath: root,
      priorInputSha256: guidedWorkspaceEditInputSha256(first.effect.input),
      executeEditFile: async () => ({ ok: true }),
    });

    expect(legacy.ok).toBe(true);
    if (!legacy.ok) throw new Error(legacy.error.message);
    expect(legacy.effect.input).toEqual(first.effect.input);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy edit recovery uses durable input identity to select one duplicate after-state candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-edit-legacy-after-duplicate-"));
  const original = "new\nold\n";
  const after = "new\nnew\n";
  await writeFile(join(root, "notes.txt"), original, "utf8");
  try {
    const first = await prepareGuidedWorkspaceFileEdit({
      args: {
        path: "notes.txt",
        start_line: 2,
        old_text: "old\n",
        new_text: "new\n",
      },
      workspacePath: root,
      executeEditFile: async () => ({ ok: true }),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);
    await writeFile(join(root, "notes.txt"), after, "utf8");

    const legacy = await prepareGuidedWorkspaceFileEdit({
      args: {
        path: "notes.txt",
        start_line: 99,
        old_text: "old\n",
        new_text: "new\n",
      },
      workspacePath: root,
      priorInputSha256: guidedWorkspaceEditInputSha256(first.effect.input),
      executeEditFile: async () => ({ ok: true }),
    });

    expect(legacy.ok).toBe(true);
    if (!legacy.ok) throw new Error(legacy.error.message);
    expect(legacy.effect.input).toEqual(first.effect.input);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy edit recovery fails closed when after-state candidates exceed its bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-edit-legacy-bound-"));
  const original = ["old", ...Array.from({ length: 16 }, () => "new")].join("\n") + "\n";
  const after = "new\n".repeat(17);
  await writeFile(join(root, "notes.txt"), original, "utf8");
  try {
    const first = await prepareGuidedWorkspaceFileEdit({
      args: {
        path: "notes.txt",
        start_line: 1,
        old_text: "old\n",
        new_text: "new\n",
      },
      workspacePath: root,
      executeEditFile: async () => ({ ok: true }),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);
    await writeFile(join(root, "notes.txt"), after, "utf8");

    const legacy = await prepareGuidedWorkspaceFileEdit({
      args: {
        path: "notes.txt",
        start_line: 99,
        old_text: "old\n",
        new_text: "new\n",
      },
      workspacePath: root,
      priorInputSha256: guidedWorkspaceEditInputSha256(first.effect.input),
      executeEditFile: async () => ({ ok: true }),
    });

    expect(legacy).toMatchObject({
      ok: false,
      error: { code: "edit_file_reconciliation_mismatch" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy edit recovery accepts an exact whole-file after-state after rename", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-edit-legacy-after-"));
  const original = "prefix\nold\nend\n";
  const after = "prefix\nnew\nend\n";
  const path = join(root, "notes.txt");
  await writeFile(path, original, "utf8");
  try {
    const first = await prepareGuidedWorkspaceFileEdit({
      args: {
        path: "notes.txt",
        start_line: 2,
        old_text: "old\n",
        new_text: "new\n",
      },
      workspacePath: root,
      executeEditFile: async () => ({ ok: true }),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);

    const temporaryPath = join(root, "notes.txt.tmp");
    await writeFile(temporaryPath, after, "utf8");
    await rename(temporaryPath, path);

    const legacy = await prepareGuidedWorkspaceFileEdit({
      args: {
        path: "notes.txt",
        start_line: 99,
        old_text: "old\n",
        new_text: "new\n",
      },
      workspacePath: root,
      priorInputSha256: guidedWorkspaceEditInputSha256(first.effect.input),
      executeEditFile: async () => ({ ok: true }),
    });

    expect(legacy.ok).toBe(true);
    if (!legacy.ok) throw new Error(legacy.error.message);
    expect(legacy.effect.input).toEqual(first.effect.input);
    expect(legacy.effect.adapter.recoveryHint?.(legacy.effect.input))
      .toMatchObject({
        capability: "edit_file",
        startLine: 2,
        beforeSha256: sha256(original),
        afterSha256: sha256(after),
      });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guided edit keeps native mode, deletion, and symlink semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-edit-native-"));
  const butlerData = join(root, "butler-data");
  const filePath = join(root, "notes.txt");
  await writeFile(filePath, "keep\nremove\nend\n", "utf8");
  await chmod(filePath, 0o600);
  let dispatches = 0;
  const executeEditFile = registeredEditFile({
    workspacePath: root,
    butlerData,
    onDispatch() {
      dispatches += 1;
    },
  });
  try {
    const deletion = await prepareGuidedWorkspaceFileEdit({
      args: {
        path: "notes.txt",
        start_line: 2,
        old_text: "remove\n",
        new_text: "",
      },
      workspacePath: root,
      butlerData,
      executeEditFile,
    });
    expect(deletion.ok).toBe(true);
    if (!deletion.ok) throw new Error(deletion.error.message);
    expect(await deletion.effect.adapter.dispatch({
      normalizedTarget: deletion.effect.target,
      normalizedInput: deletion.effect.input,
      idempotencyKey: "edit-delete",
      signal: new AbortController().signal,
    })).toMatchObject({ status: "applied" });
    expect(await readFile(filePath, "utf8")).toBe("keep\nend\n");
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(dispatches).toBe(1);

    await writeFile(join(root, "referent.txt"), "old\n", "utf8");
    await symlink("referent.txt", join(root, "link.txt"));
    expect(await prepareGuidedWorkspaceFileEdit({
      args: {
        path: "link.txt",
        start_line: 1,
        old_text: "old\n",
        new_text: "new\n",
      },
      workspacePath: root,
      butlerData,
      executeEditFile,
    })).toMatchObject({
      ok: false,
      error: { code: "target_not_regular_file" },
    });
    expect((await lstat(join(root, "link.txt"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(root, "referent.txt"), "utf8")).toBe("old\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guided edit does not infer a fresh success from matching replacement text", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-edit-fresh-"));
  await writeFile(join(root, "styles.css"), "overflow-x: hidden;\n", "utf8");
  try {
    expect(await prepareGuidedWorkspaceFileEdit({
      args: {
        path: "styles.css",
        start_line: 1,
        old_text: "overflow-x: auto;\n",
        new_text: "overflow-x: hidden;\n",
      },
      workspacePath: root,
      executeEditFile: async () => {
        throw new Error("fresh mismatches must not dispatch");
      },
    })).toMatchObject({
      ok: false,
      error: { code: "old_text_mismatch" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guided edit reconciles an atomic replacement after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-edit-restart-"));
  const workspacePath = join(root, "workspace");
  const butlerData = join(root, "butler-data");
  const dbPath = join(root, "effects.sqlite");
  const original = "body {\n  overflow-x: auto;\n}\n";
  const expected = "body {\n  overflow-x: hidden;\n}\n";
  const args = {
    path: "styles.css",
    start_line: 2,
    old_text: "  overflow-x: auto;\n",
    new_text: "  overflow-x: hidden;\n",
  };
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, args.path), original, "utf8");
  let registeredDispatches = 0;
  const executeEditFile = registeredEditFile({
    workspacePath,
    butlerData,
    onDispatch() {
      registeredDispatches += 1;
    },
  });
  const work = reviewedFileWork("workspace:landing-page-source-files");
  work.currentPlan!.actions[0]!.effect = {
    capability: "workspace mutation",
    target: "workspace:landing-page-source-files",
  };
  let firstDb: Database | undefined;
  let resumedDb: Database | undefined;
  try {
    const firstPrepared = await prepareGuidedWorkspaceFileEdit({
      args,
      workspacePath,
      butlerData,
      executeEditFile,
    });
    expect(firstPrepared.ok).toBe(true);
    if (!firstPrepared.ok) throw new Error(firstPrepared.error.message);
    firstDb = openEffectDatabase(dbPath);
    const crashing = createGuidedEffectService(
      new SqliteGuidedEffectJournal(firstDb),
      {
        faultHook(point) {
          if (point === "after_dispatch") {
            throw new Error("simulated stop after edit rename");
          }
        },
      },
    );
    await expect(crashing.execute({
      work,
      accessMode: "full_access",
      occurrenceId: "tool-call-edit-restart-1",
      signal: new AbortController().signal,
      target: firstPrepared.effect.target,
      input: firstPrepared.effect.input,
      adapter: firstPrepared.effect.adapter,
    })).rejects.toThrow("simulated stop after edit rename");
    expect(await readFile(join(workspacePath, args.path), "utf8")).toBe(expected);
    expect(registeredDispatches).toBe(1);
    const priorRecord = new SqliteGuidedEffectJournal(firstDb)
      .listForWork(work.workId)[0];
    const priorInputSha256 = priorRecord?.inputSha256;
    const priorRecoveryHint = priorRecord?.recoveryHint;
    expect(priorInputSha256).toBeString();
    expect(priorRecoveryHint).toMatchObject({
      capability: "edit_file",
      startLine: 2,
    });
    if (!priorInputSha256) throw new Error("Missing durable edit input hash");
    if (!priorRecoveryHint) throw new Error("Missing durable edit recovery hint");
    firstDb.close();
    firstDb = undefined;

    const resumedPrepared = await prepareGuidedWorkspaceFileEdit({
      args,
      workspacePath,
      butlerData,
      executeEditFile,
      priorInputSha256,
      priorRecoveryHint,
    });
    expect(resumedPrepared.ok).toBe(true);
    if (!resumedPrepared.ok) throw new Error(resumedPrepared.error.message);
    expect(resumedPrepared.effect.input).toEqual(firstPrepared.effect.input);
    resumedDb = openEffectDatabase(dbPath);
    const resumed = await createGuidedEffectService(
      new SqliteGuidedEffectJournal(resumedDb),
    ).execute({
      work,
      accessMode: "full_access",
      occurrenceId: "tool-call-edit-restart-1",
      signal: new AbortController().signal,
      target: resumedPrepared.effect.target,
      input: resumedPrepared.effect.input,
      adapter: resumedPrepared.effect.adapter,
    });
    expect(resumed).toMatchObject({
      ok: true,
      status: "applied",
      receipt: {
        capability: "edit_file",
        sanitizedTarget: "workspace:styles.css",
      },
    });
    expect(registeredDispatches).toBe(1);
  } finally {
    firstDb?.close();
    resumedDb?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("guided edit restart resolves repeated new_text by durable input identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-edit-repeat-restart-"));
  const workspacePath = join(root, "workspace");
  const butlerData = join(root, "butler-data");
  const dbPath = join(root, "effects.sqlite");
  const original = "new\nold\n";
  const expected = "new\nnew\n";
  const args = {
    path: "notes.txt",
    start_line: 2,
    old_text: "old\n",
    new_text: "new\n",
  };
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, args.path), original, "utf8");
  let registeredDispatches = 0;
  const executeEditFile = registeredEditFile({
    workspacePath,
    butlerData,
    onDispatch() {
      registeredDispatches += 1;
    },
  });
  const work = reviewedFileWork(workspaceFileEffectTarget(args.path));
  let firstDb: Database | undefined;
  let resumedDb: Database | undefined;
  try {
    const firstPrepared = await prepareGuidedWorkspaceFileEdit({
      args,
      workspacePath,
      butlerData,
      executeEditFile,
    });
    expect(firstPrepared.ok).toBe(true);
    if (!firstPrepared.ok) throw new Error(firstPrepared.error.message);
    firstDb = openEffectDatabase(dbPath);
    await expect(createGuidedEffectService(
      new SqliteGuidedEffectJournal(firstDb),
      { faultHook: (point) => {
        if (point === "after_dispatch") throw new Error("simulated edit crash");
      } },
    ).execute({
      work,
      accessMode: "full_access",
      occurrenceId: "tool-call-repeat-restart-1",
      signal: new AbortController().signal,
      target: firstPrepared.effect.target,
      input: firstPrepared.effect.input,
      adapter: firstPrepared.effect.adapter,
    })).rejects.toThrow("simulated edit crash");
    expect(await readFile(join(workspacePath, args.path), "utf8")).toBe(expected);
    expect(registeredDispatches).toBe(1);
    const priorRecord = new SqliteGuidedEffectJournal(firstDb)
      .listForWork(work.workId)[0];
    const priorInputSha256 = priorRecord?.inputSha256;
    const priorRecoveryHint = priorRecord?.recoveryHint;
    expect(priorInputSha256).toBeString();
    expect(priorRecoveryHint).toMatchObject({
      capability: "edit_file",
      startLine: 2,
    });
    if (!priorInputSha256) throw new Error("Missing durable edit input hash");
    if (!priorRecoveryHint) throw new Error("Missing durable edit recovery hint");
    firstDb.close();
    firstDb = undefined;

    resumedDb = openEffectDatabase(dbPath);
    const resumedPrepared = await prepareGuidedWorkspaceFileEdit({
      args: { ...args, start_line: 1 },
      workspacePath,
      butlerData,
      executeEditFile,
      priorInputSha256,
      priorRecoveryHint,
    });
    expect(resumedPrepared.ok).toBe(true);
    if (!resumedPrepared.ok) throw new Error(resumedPrepared.error.message);
    if ("edits" in resumedPrepared.effect.input) throw new Error("expected single edit");
    expect(resumedPrepared.effect.input.start_line).toBe(2);
    const resumed = await createGuidedEffectService(
      new SqliteGuidedEffectJournal(resumedDb),
    ).execute({
      work,
      accessMode: "full_access",
      occurrenceId: "tool-call-repeat-restart-1",
      signal: new AbortController().signal,
      target: resumedPrepared.effect.target,
      input: resumedPrepared.effect.input,
      adapter: resumedPrepared.effect.adapter,
    });
    expect(resumed).toMatchObject({
      ok: true,
      status: "applied",
      result: { start_line: 2 },
      receipt: { result: { start_line: 2 } },
    });
    expect(registeredDispatches).toBe(1);
  } finally {
    firstDb?.close();
    resumedDb?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("guided deletion restart resolves an omitted start_line by durable input identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-edit-delete-restart-"));
  const workspacePath = join(root, "workspace");
  const butlerData = join(root, "butler-data");
  const dbPath = join(root, "effects.sqlite");
  const original = "keep\nprefix remove suffix\nend\n";
  const expected = "keep\nprefix suffix\nend\n";
  const args = {
    path: "notes.txt",
    start_line: 2,
    old_text: "remove ",
    new_text: "",
  };
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, args.path), original, "utf8");
  let registeredDispatches = 0;
  const executeEditFile = registeredEditFile({
    workspacePath,
    butlerData,
    onDispatch() {
      registeredDispatches += 1;
    },
  });
  const work = reviewedFileWork(workspaceFileEffectTarget(args.path));
  let firstDb: Database | undefined;
  let resumedDb: Database | undefined;
  try {
    const firstPrepared = await prepareGuidedWorkspaceFileEdit({
      args,
      workspacePath,
      butlerData,
      executeEditFile,
    });
    expect(firstPrepared.ok).toBe(true);
    if (!firstPrepared.ok) throw new Error(firstPrepared.error.message);
    firstDb = openEffectDatabase(dbPath);
    await expect(createGuidedEffectService(
      new SqliteGuidedEffectJournal(firstDb),
      { faultHook: (point) => {
        if (point === "after_dispatch") throw new Error("simulated delete crash");
      } },
    ).execute({
      work,
      accessMode: "full_access",
      occurrenceId: "tool-call-delete-restart-1",
      signal: new AbortController().signal,
      target: firstPrepared.effect.target,
      input: firstPrepared.effect.input,
      adapter: firstPrepared.effect.adapter,
    })).rejects.toThrow("simulated delete crash");
    expect(await readFile(join(workspacePath, args.path), "utf8")).toBe(expected);
    expect(registeredDispatches).toBe(1);
    const priorRecord = new SqliteGuidedEffectJournal(firstDb)
      .listForWork(work.workId)[0];
    const priorInputSha256 = priorRecord?.inputSha256;
    const priorRecoveryHint = priorRecord?.recoveryHint;
    expect(priorInputSha256).toBeString();
    expect(priorRecoveryHint).toMatchObject({
      capability: "edit_file",
      startLine: 2,
    });
    if (!priorInputSha256) throw new Error("Missing durable delete input hash");
    if (!priorRecoveryHint) throw new Error("Missing durable delete recovery hint");
    firstDb.close();
    firstDb = undefined;

    resumedDb = openEffectDatabase(dbPath);
    const resumedPrepared = await prepareGuidedWorkspaceFileEdit({
      args: { path: args.path, old_text: args.old_text, new_text: args.new_text },
      workspacePath,
      butlerData,
      executeEditFile,
      priorInputSha256,
      priorRecoveryHint,
    });
    expect(resumedPrepared.ok).toBe(true);
    if (!resumedPrepared.ok) throw new Error(resumedPrepared.error.message);
    if ("edits" in resumedPrepared.effect.input) throw new Error("expected single edit");
    expect(resumedPrepared.effect.input.start_line).toBe(2);
    const resumed = await createGuidedEffectService(
      new SqliteGuidedEffectJournal(resumedDb),
    ).execute({
      work,
      accessMode: "full_access",
      occurrenceId: "tool-call-delete-restart-1",
      signal: new AbortController().signal,
      target: resumedPrepared.effect.target,
      input: resumedPrepared.effect.input,
      adapter: resumedPrepared.effect.adapter,
    });
    expect(resumed).toMatchObject({
      ok: true,
      status: "applied",
      result: { start_line: 2 },
      receipt: { result: { start_line: 2 } },
    });
    expect(registeredDispatches).toBe(1);
  } finally {
    firstDb?.close();
    resumedDb?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("guided edit never guesses an after-state without prior input identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-edit-no-prior-"));
  await writeFile(join(root, "notes.txt"), "new\n", "utf8");
  try {
    expect(await prepareGuidedWorkspaceFileEdit({
      args: {
        path: "notes.txt",
        old_text: "old\n",
        new_text: "new\n",
      },
      workspacePath: root,
      executeEditFile: async () => {
        throw new Error("fresh after-state must not dispatch");
      },
    })).toMatchObject({
      ok: false,
      error: { code: "old_text_mismatch" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace file reconciliation distinguishes observed, undispatched, and uncertain bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-file-observe-"));
  const adapter = createGuidedWorkspaceFileEffectAdapter({
    workspacePath: root,
    executeWriteFile: async () => {
      throw new Error("reconciliation must not dispatch");
    },
  });
  const signal = new AbortController().signal;
  try {
    const createInput = adapter.normalizeInput({
      path: "new.md",
      content: "desired",
    });
    expect(await adapter.reconcile({
      normalizedTarget: workspaceFileEffectTarget(createInput.path),
      normalizedInput: createInput,
      idempotencyKey: "create",
      signal,
      dispatchAttempts: 0,
    })).toEqual({ status: "not_applied" });

    const original = "original";
    await writeFile(join(root, "existing.md"), original, "utf8");
    const replaceInput = adapter.normalizeInput({
      path: "existing.md",
      content: "desired",
    });
    expect(await adapter.reconcile({
      normalizedTarget: workspaceFileEffectTarget(replaceInput.path),
      normalizedInput: replaceInput,
      idempotencyKey: "undispatched-replace",
      signal,
      dispatchAttempts: 0,
    })).toEqual({ status: "not_applied" });

    expect(await adapter.reconcile({
      normalizedTarget: workspaceFileEffectTarget(replaceInput.path),
      normalizedInput: replaceInput,
      idempotencyKey: "dispatched-replace",
      signal,
      dispatchAttempts: 1,
    })).toMatchObject({
      status: "uncertain",
      error: { code: "workspace_file_state_mismatch" },
    });

    await writeFile(join(root, "existing.md"), "desired", "utf8");
    expect(await adapter.reconcile({
      normalizedTarget: workspaceFileEffectTarget(replaceInput.path),
      normalizedInput: replaceInput,
      idempotencyKey: "observed",
      signal,
      dispatchAttempts: 1,
    })).toMatchObject({
      status: "applied",
      result: {
        after_sha256: sha256("desired"),
        target_observed: true,
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("first execution adopts already-present desired bytes without dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-file-adopt-"));
  const workspacePath = join(root, "workspace");
  const dbPath = join(root, "effects.sqlite");
  const content = "already durable\n";
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, "result.md"), content, "utf8");

  const db = openEffectDatabase(dbPath);
  let dispatches = 0;
  const adapter = createGuidedWorkspaceFileEffectAdapter({
    workspacePath,
    executeWriteFile: async () => {
      dispatches += 1;
      return { ok: true };
    },
  });
  const effectInput: GuidedWorkspaceFileInput = {
    path: "result.md",
    content,
    create_parents: false,
  };
  const target = workspaceFileEffectTarget(effectInput.path);

  try {
    const result = await createGuidedEffectService(
      new SqliteGuidedEffectJournal(db),
    ).execute({
      work: reviewedFileWork(target),
      accessMode: "full_access",
      occurrenceId: "tool-call-adopt-1",
      signal: new AbortController().signal,
      target,
      input: effectInput,
      adapter,
    });

    expect(result).toMatchObject({
      ok: true,
      status: "applied",
      replayed: false,
      result: {
        after_sha256: sha256(content),
        target_observed: true,
      },
    });
    expect(dispatches).toBe(0);
    expect(readJournalStatus(db)).toBe("applied");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rename then crash is reconciled after restart without a duplicate registered write", async () => {
  const root = await mkdtemp(join(tmpdir(), "butler-guided-file-restart-"));
  const workspacePath = join(root, "workspace");
  const butlerData = join(root, "butler-data");
  const dbPath = join(root, "effects.sqlite");
  await mkdir(workspacePath, { recursive: true });

  let registeredDispatches = 0;
  let registeredResult: unknown;
  const executeRegisteredWrite = registeredWriteFile({
    workspacePath,
    butlerData,
    onDispatch(result) {
      registeredDispatches += 1;
      registeredResult = result;
    },
  });
  const effectInput: GuidedWorkspaceFileInput = {
    path: "reports/summary.md",
    content: "# Summary\n\nCafe\u0301 durable result.\n",
    create_parents: true,
  };
  const target = workspaceFileEffectTarget(effectInput.path);
  const work = reviewedFileWork(target);

  let firstDb: Database | undefined;
  let resumedDb: Database | undefined;
  try {
    firstDb = openEffectDatabase(dbPath);
    const crashAfterRename: GuidedEffectFaultHook = (point) => {
      if (point === "after_dispatch") {
        throw new Error("simulated process crash after atomic rename");
      }
    };
    const firstService = createGuidedEffectService(
      new SqliteGuidedEffectJournal(firstDb),
      { faultHook: crashAfterRename },
    );
    const firstAdapter = createGuidedWorkspaceFileEffectAdapter({
      workspacePath,
      butlerData,
      executeWriteFile: executeRegisteredWrite,
    });

    await expect(firstService.execute({
      work,
      accessMode: "full_access",
      occurrenceId: "tool-call-restart-1",
      signal: new AbortController().signal,
      target,
      input: effectInput,
      adapter: firstAdapter,
    })).rejects.toThrow("simulated process crash after atomic rename");
    expect(registeredDispatches).toBe(1);
    expect(registeredResult).toMatchObject({
      ok: true,
      atomic_write: true,
      after_sha256: sha256(effectInput.content),
    });
    expect(await readFile(
      join(workspacePath, effectInput.path),
      "utf8",
    )).toBe(effectInput.content);
    expect(readJournalStatus(firstDb)).toBe("dispatching");
    firstDb.close();
    firstDb = undefined;

    resumedDb = openEffectDatabase(dbPath);
    const resumedService = createGuidedEffectService(
      new SqliteGuidedEffectJournal(resumedDb),
    );
    const resumedAdapter = createGuidedWorkspaceFileEffectAdapter({
      workspacePath,
      butlerData,
      executeWriteFile: executeRegisteredWrite,
    });
    const resumed = await resumedService.execute({
      work,
      accessMode: "full_access",
      occurrenceId: "tool-call-restart-1",
      signal: new AbortController().signal,
      target,
      input: effectInput,
      adapter: resumedAdapter,
    });

    expect(resumed).toMatchObject({
      ok: true,
      status: "applied",
      replayed: false,
      result: {
        effect: "workspace_file_write",
        path: effectInput.path,
        after_sha256: sha256(effectInput.content),
        target_observed: true,
      },
      receipt: {
        capability: "write_file",
        sanitizedTarget: target,
      },
    });
    expect(registeredDispatches).toBe(1);
    expect(readJournalStatus(resumedDb)).toBe("applied");

    const replayed = await resumedService.execute({
      work,
      accessMode: "full_access",
      occurrenceId: "tool-call-restart-1",
      signal: new AbortController().signal,
      target,
      input: effectInput,
      adapter: resumedAdapter,
    });
    expect(replayed).toMatchObject({
      ok: true,
      status: "applied",
      replayed: true,
    });
    expect(registeredDispatches).toBe(1);
  } finally {
    firstDb?.close();
    resumedDb?.close();
    await rm(root, { recursive: true, force: true });
  }
});

function registeredWriteFile(input: {
  workspacePath: string;
  butlerData: string;
  onDispatch(result: unknown): void;
}) {
  const handlers = createFileToolHandlers({
    workspacePath: input.workspacePath,
    butlerData: input.butlerData,
  });
  const writeFile = handlers.write_file;
  if (!writeFile) throw new Error("registered write_file handler is missing");
  return async (args: GuidedWorkspaceFileInput & {
    overwrite: boolean;
    expected_sha256?: string;
  }): Promise<unknown> => {
    const result = await writeFile({
      name: "write_file",
      args,
      rawArguments: JSON.stringify(args),
    });
    input.onDispatch(result);
    return result;
  };
}

function registeredEditFile(input: {
  workspacePath: string;
  butlerData: string;
  onDispatch(result: unknown): void;
}) {
  const handlers = createFileToolHandlers({
    workspacePath: input.workspacePath,
    butlerData: input.butlerData,
  });
  const editFile = handlers.edit_file;
  if (!editFile) throw new Error("registered edit_file handler is missing");
  return async (args: {
    path: string;
    start_line: number;
    old_text: string;
    new_text: string;
    expected_sha256: string;
  }): Promise<unknown> => {
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

function readJournalStatus(db: Database): string | null {
  return db.query<{ status: string }, []>(`
    SELECT status
    FROM btcc_guided_effects
    ORDER BY created_at
    LIMIT 1
  `).get()?.status ?? null;
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
    actionProgress: [{
      actionKey: "write-summary",
      status: "active",
    }],
    currentPlan: {
      planRevisionId,
      revision: 1,
      objective: "Write the summary file",
      actions: [{
        actionKey: "write-summary",
        description: "Write the requested summary",
        dependencyKeys: [],
        effect: { capability: "write_file", target },
      }],
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
