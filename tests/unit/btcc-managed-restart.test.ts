import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("BTCC managed restart", () => {
  test("resumes the selected Attempt without duplicating Ledger mutation", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "butler-btcc-ledger-restart-"));
    temporaryRoots.push(dataRoot);
    const harness = resolve(
      import.meta.dir,
      "../../packages/butler-agent/src/interfaces/btcc-harness/run-btcc-harness.ts",
    );
    const args = [
      process.execPath,
      "run",
      harness,
      "--data", dataRoot,
      "--turn", "turn-ledger-restart",
      "--session", "session-ledger-restart",
      "--message", "운영 가이드를 조사해서 작성해줘.",
      "--provider", "harness",
      "--model", "managed-v1",
      "--effort", "medium",
      "--scenario", "managed-restart-once",
    ];
    const first = Bun.spawn(args, {
      cwd: resolve(import.meta.dir, "../.."), stderr: "pipe", stdout: "pipe",
    });
    const [firstExit, firstError, firstOutput] = await Promise.all([
      first.exited,
      new Response(first.stderr).text(),
      new Response(first.stdout).text(),
    ]);
    expect(firstExit).toBe(1);
    expect(firstError).toContain("BTCC operational interruption: simulated_provider_unavailable");
    expect(firstOutput).toBe("");

    assertInterruptedTurn(dataRoot);

    const resumed = Bun.spawn(args, {
      cwd: resolve(import.meta.dir, "../.."), stderr: "pipe", stdout: "pipe",
    });
    const [resumedExit, resumedOutput, resumedError] = await Promise.all([
      resumed.exited,
      new Response(resumed.stdout).text(),
      new Response(resumed.stderr).text(),
    ]);
    expect(resumedError).toBe("");
    expect(resumedExit).toBe(0);
    expect(resumedOutput).toContain('"kind":"delivered"');

    assertResumedTurn(dataRoot);
  });
});

function assertInterruptedTurn(dataRoot: string): void {
  const db = new Database(join(dataRoot, "runtime", "btcc-successor.sqlite"), {
    readonly: true,
  });
  try {
    const turn = db.query<{
      semantic_state: string;
      active_checkpoint_id: string;
    }, []>("SELECT semantic_state, active_checkpoint_id FROM btcc_turns").get();
    const claims = db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM btcc_state_claims WHERE status = 'active'
    `).get();
    const waiting = db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM btcc_turns WHERE semantic_state = 'waiting_runtime'
    `).get();
    expect(turn?.semantic_state).toBe("task_execution");
    expect(turn?.active_checkpoint_id).toBeTruthy();
    expect(claims?.count).toBe(1);
    expect(waiting?.count).toBe(0);
  } finally {
    db.close();
  }
}

function assertResumedTurn(dataRoot: string): void {
  const db = new Database(join(dataRoot, "runtime", "btcc-successor.sqlite"), {
    readonly: true,
  });
  try {
    const attempts = db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM btcc_attempts
    `).get();
    const mutations = db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM btcc_ledger_mutations
    `).get();
    expect(attempts?.count).toBe(2);
    expect(mutations?.count).toBe(9);
  } finally {
    db.close();
  }
}
