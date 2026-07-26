import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("BTCC managed restart", () => {
  test("re-enters the exact interrupted Attempt without a process restart", async () => {
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
    const run = Bun.spawn(args, {
      cwd: resolve(import.meta.dir, "../.."), stderr: "pipe", stdout: "pipe",
    });
    const [exit, error, output] = await Promise.all([
      run.exited,
      new Response(run.stderr).text(),
      new Response(run.stdout).text(),
    ]);
    expect(error).toBe("");
    expect(exit).toBe(0);
    expect(output).toContain('"kind":"delivered"');

    assertResumedTurn(dataRoot);
  });

  test("adopts a durable interruption after the owning process exits", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "butler-btcc-process-restart-"));
    temporaryRoots.push(dataRoot);
    const args = harnessArgs(dataRoot, "turn-process-restart");
    const first = Bun.spawn(args, {
      cwd: resolve(import.meta.dir, "../.."), stderr: "pipe", stdout: "pipe",
    });
    await waitForInterruption(dataRoot);
    first.kill();
    await first.exited;

    const resumed = Bun.spawn(args, {
      cwd: resolve(import.meta.dir, "../.."), stderr: "pipe", stdout: "pipe",
    });
    const [exit, output, error] = await Promise.all([
      resumed.exited,
      new Response(resumed.stdout).text(),
      new Response(resumed.stderr).text(),
    ]);
    expect(error).toBe("");
    expect(exit).toBe(0);
    expect(output).toContain('"kind":"delivered"');
    assertResumedTurn(dataRoot);
  });

  test("new process re-enters inherited runtime remediation at the exact phase", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "butler-btcc-runtime-repair-"));
    temporaryRoots.push(dataRoot);
    const args = harnessArgs(
      dataRoot,
      "turn-runtime-repair",
      "managed-runtime-remediation-once",
    );
    const first = Bun.spawn(args, {
      cwd: resolve(import.meta.dir, "../.."), stderr: "pipe", stdout: "pipe",
    });
    await waitForInterruption(dataRoot);
    first.kill();
    await first.exited;

    const resumed = Bun.spawn(args, {
      cwd: resolve(import.meta.dir, "../.."), stderr: "pipe", stdout: "pipe",
    });
    const [exit, output, error] = await Promise.all([
      resumed.exited,
      new Response(resumed.stdout).text(),
      new Response(resumed.stderr).text(),
    ]);
    expect(error).toBe("");
    expect(exit).toBe(0);
    const result = JSON.parse(output) as { phases: string[]; initial: { kind: string } };
    expect(result.initial.kind).toBe("delivered");
    expect(result.phases[0]).toBe("task_execution");
    expect(result.phases).not.toContain("conception_opening");
    expect(result.phases).not.toContain("planning");
    assertResumedTurn(dataRoot);
  });
});

function harnessArgs(
  dataRoot: string,
  turnId: string,
  scenario = "managed-restart-once",
): string[] {
  return [
    process.execPath,
    "run",
    resolve(
      import.meta.dir,
      "../../packages/butler-agent/src/interfaces/btcc-harness/run-btcc-harness.ts",
    ),
    "--data", dataRoot,
    "--turn", turnId,
    "--session", `session-${turnId}`,
    "--message", "운영 가이드를 조사해서 작성해줘.",
    "--provider", "harness",
    "--model", "managed-v1",
    "--effort", "medium",
    "--scenario", scenario,
  ];
}

async function waitForInterruption(dataRoot: string): Promise<void> {
  const dbPath = join(dataRoot, "runtime", "btcc-successor.sqlite");
  for (let index = 0; index < 500; index += 1) {
    if (existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      try {
        const record = db.query<{ count: number }, []>(`
          SELECT COUNT(*) AS count FROM btcc_operational_interruptions
          WHERE status = 'interrupted'
        `).get();
        if ((record?.count ?? 0) > 0) return;
      } catch {
        // Schema creation may still be in progress.
      } finally {
        db.close();
      }
    }
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for durable BTCC interruption ownership");
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
    const recoveries = db.query<{ status: string; activation_count: number }, []>(`
      SELECT status, activation_count FROM btcc_operational_interruptions
    `).all();
    const waiting = db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM btcc_turns WHERE semantic_state = 'waiting_runtime'
    `).get();
    expect(attempts?.count).toBe(2);
    expect(mutations?.count).toBe(9);
    expect(recoveries).toEqual([{ status: "resolved", activation_count: 1 }]);
    expect(waiting?.count).toBe(0);
  } finally {
    db.close();
  }
}
