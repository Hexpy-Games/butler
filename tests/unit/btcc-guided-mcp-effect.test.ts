import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGuidedEffectJournal } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { prepareGuidedMcpToolEffect } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-mcp-tool-effect.ts";
import { createGuidedEffectService } from
  "../../packages/butler-agent/src/agent/btcc/effects/index.ts";
import { reviewedWork } from "./support/guided-effect-test-fixture.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reviewed MCP effect replays an applied receipt after SQLite restart", async () => {
  const root = temporaryRoot("guided-mcp-applied");
  const dbPath = join(root, "effects.sqlite");
  let dispatches = 0;
  let db = openEffectDatabase(dbPath);
  const first = preparedEffect(async (prepared) => {
    dispatches += 1;
    expect(prepared?.args).toEqual({
      server_id: "fixture",
      tool_name: "find_issue",
      arguments: { query: "BTCC" },
    });
    return { content: [{ type: "text", text: "issue:BTCC" }] };
  });
  const applied = await executeEffect(db, first);
  expect(applied).toMatchObject({
    ok: true,
    status: "applied",
    replayed: false,
    result: { content: [{ type: "text", text: "issue:BTCC" }] },
  });
  db.close();

  db = openEffectDatabase(dbPath);
  try {
    const resumed = preparedEffect(async () => {
      dispatches += 1;
      throw new Error("an applied MCP effect must not dispatch again");
    });
    expect(await executeEffect(db, resumed)).toMatchObject({
      ok: true,
      status: "applied",
      replayed: true,
      result: { content: [{ type: "text", text: "issue:BTCC" }] },
    });
    expect(dispatches).toBe(1);
  } finally {
    db.close();
  }
});

test("reviewed MCP effect preserves uncertain dispatch without blind retry", async () => {
  const root = temporaryRoot("guided-mcp-uncertain");
  const dbPath = join(root, "effects.sqlite");
  let dispatches = 0;
  let db = openEffectDatabase(dbPath);
  const first = preparedEffect(async () => {
    dispatches += 1;
    throw new Error("transport ended after the MCP process received the call");
  });
  expect(await executeEffect(db, first)).toMatchObject({
    ok: false,
    status: "uncertain",
    error: {
      code: "effect_reconciliation_required",
      sourceCode: "mcp_tool_dispatch_uncertain",
    },
  });
  db.close();

  db = openEffectDatabase(dbPath);
  try {
    const resumed = preparedEffect(async () => {
      dispatches += 1;
      return { content: [] };
    });
    expect(await executeEffect(db, resumed)).toMatchObject({
      ok: false,
      status: "uncertain",
      error: {
        code: "effect_reconciliation_required",
        sourceCode: "mcp_tool_dispatch_uncertain",
      },
      evidence: {
        dispatchAttempt: 1,
        errorCode: "effect_reconciliation_required",
      },
    });
    expect(dispatches).toBe(1);
    expect(new SqliteGuidedEffectJournal(db).listForWork("guided-work-1"))
      .toEqual([
        expect.objectContaining({
          capability: "call_mcp_tool",
          status: "uncertain",
          dispatchAttempts: 1,
        }),
      ]);
  } finally {
    db.close();
  }
});

test("MCP effect without an accepted Plan Review performs no dispatch", async () => {
  const root = temporaryRoot("guided-mcp-unreviewed");
  const db = openEffectDatabase(join(root, "effects.sqlite"));
  let dispatches = 0;
  try {
    const prepared = preparedEffect(async () => {
      dispatches += 1;
      return { content: [] };
    });
    expect(await executeEffect(
      db,
      prepared,
      reviewedWork({ includeReview: false }),
    )).toMatchObject({
      ok: false,
      status: "rejected",
      error: { code: "effect_plan_review_required" },
    });
    expect(dispatches).toBe(0);
  } finally {
    db.close();
  }
});

test("MCP effect cancelled before dispatch performs no external call", async () => {
  const root = temporaryRoot("guided-mcp-cancelled");
  const db = openEffectDatabase(join(root, "effects.sqlite"));
  let dispatches = 0;
  const controller = new AbortController();
  controller.abort();
  try {
    const prepared = preparedEffect(async () => {
      dispatches += 1;
      return { content: [] };
    });
    expect(await createGuidedEffectService(
      new SqliteGuidedEffectJournal(db),
    ).execute({
      work: reviewedWork(),
      accessMode: "full_access",
      occurrenceId: "mcp-cancelled-occurrence",
      signal: controller.signal,
      target: prepared.target,
      input: prepared.input,
      adapter: prepared.adapter,
    })).toMatchObject({
      ok: false,
      status: "rejected",
      error: { code: "effect_cancelled" },
    });
    expect(dispatches).toBe(0);
  } finally {
    db.close();
  }
});

function preparedEffect(
  executeRegistered: Parameters<typeof prepareGuidedMcpToolEffect>[0]["executeRegistered"],
) {
  return prepareGuidedMcpToolEffect({
    args: {
      server_id: "fixture",
      tool_name: "find_issue",
      arguments: { query: "BTCC" },
    },
    executeRegistered,
  });
}

function executeEffect(
  db: Database,
  prepared: ReturnType<typeof prepareGuidedMcpToolEffect>,
  work = reviewedWork(),
) {
  return createGuidedEffectService(new SqliteGuidedEffectJournal(db)).execute({
    work,
    accessMode: "full_access",
    occurrenceId: "mcp-effect-occurrence",
    signal: new AbortController().signal,
    target: prepared.target,
    input: prepared.input,
    adapter: prepared.adapter,
  });
}

function openEffectDatabase(path: string): Database {
  const db = new Database(path);
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  return db;
}

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `${label}-`));
  roots.push(root);
  return root;
}
