import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGuidedEffectJournal } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import type { DurableWorkView } from
  "../../packages/butler-agent/src/agent/btcc/durable-work/index.ts";
import {
  createGuidedEffectService,
  type GuidedEffectFaultHook,
} from "../../packages/butler-agent/src/agent/btcc/effects/index.ts";
import {
  createGuidedWorkspaceFileEffectAdapter,
  type GuidedWorkspaceFileInput,
  workspaceFileEffectTarget,
} from
  "../../packages/butler-agent/src/agent/composition/production-btcc/guided-workspace-file-effect.ts";
import { createFileToolHandlers } from
  "../../packages/butler-agent/src/agent/tools/file-tools/index.ts";

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
    expect(() => adapter.normalizeInput({
      path: "/tmp/report.md",
      content: "private",
      overwrite: false,
    })).toThrow("workspace-relative");

    const protectedInput = adapter.normalizeInput({
      path: "butler-data/project-ledger/projects/demo/specs/feature.md",
      content: "must not write",
      overwrite: false,
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

test("workspace file reconciliation distinguishes observed, safe retry, and uncertain bytes", async () => {
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
      overwrite: false,
    });
    expect(await adapter.reconcile({
      normalizedTarget: workspaceFileEffectTarget(createInput.path),
      normalizedInput: createInput,
      idempotencyKey: "create",
      signal,
    })).toEqual({ status: "not_applied" });

    const original = "original";
    await writeFile(join(root, "existing.md"), original, "utf8");
    const guardedOverwrite = adapter.normalizeInput({
      path: "existing.md",
      content: "desired",
      overwrite: true,
      expected_sha256: sha256(original),
    });
    expect(await adapter.reconcile({
      normalizedTarget: workspaceFileEffectTarget(guardedOverwrite.path),
      normalizedInput: guardedOverwrite,
      idempotencyKey: "guarded-overwrite",
      signal,
    })).toEqual({ status: "not_applied" });

    const unguardedOverwrite = adapter.normalizeInput({
      path: "existing.md",
      content: "desired",
      overwrite: true,
    });
    expect(await adapter.reconcile({
      normalizedTarget: workspaceFileEffectTarget(unguardedOverwrite.path),
      normalizedInput: unguardedOverwrite,
      idempotencyKey: "unguarded-overwrite",
      signal,
    })).toMatchObject({
      status: "uncertain",
      error: { code: "workspace_file_state_mismatch" },
    });

    await writeFile(join(root, "existing.md"), "desired", "utf8");
    expect(await adapter.reconcile({
      normalizedTarget: workspaceFileEffectTarget(unguardedOverwrite.path),
      normalizedInput: unguardedOverwrite,
      idempotencyKey: "observed",
      signal,
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
    overwrite: true,
    create_parents: false,
  };
  const target = workspaceFileEffectTarget(effectInput.path);

  try {
    const result = await createGuidedEffectService(
      new SqliteGuidedEffectJournal(db),
    ).execute({
      work: reviewedFileWork(target),
      accessMode: "full_access",
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
    overwrite: false,
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
  return async (args: GuidedWorkspaceFileInput): Promise<unknown> => {
    const result = await writeFile({
      name: "write_file",
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
