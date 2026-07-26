import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("governing revision re-reviews an accepted result without rerunning Execution", async () => {
  const { dataRoot, result } = await runRevalidation();
  expect(result.initial.kind).toBe("delivered");
  expectRevalidationPhases(result.phases);

  const db = new Database(join(dataRoot, "runtime", "btcc-successor.sqlite"), {
    readonly: true,
  });
  try {
    const attempts = db.query<{ task_id: string; attempts: number }, []>(`
      SELECT task_id, COUNT(*) AS attempts
      FROM btcc_attempts GROUP BY task_id ORDER BY MIN(rowid)
    `).all();
    expect(attempts.reduce((sum, item) => sum + item.attempts, 0)).toBe(3);
    expect(attempts.every((item) => item.attempts === 1)).toBe(true);
    expect(db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM btcc_records WHERE kind = 'task_review'
    `).get()?.count).toBe(4);
  } finally {
    db.close();
  }
});

test("Project Work Ledger applies the same governing revalidation path", async () => {
  const { dataRoot, result } = await runRevalidation("project:harness-revalidation");
  expect(result.initial.kind).toBe("delivered");
  expectRevalidationPhases(result.phases);

  const db = new Database(join(dataRoot, "runtime", "btcc-successor.sqlite"), {
    readonly: true,
  });
  try {
    const row = db.query<{ phase_envelope_json: string }, []>(`
      SELECT revision.phase_envelope_json
      FROM btcc_phase_checkpoint_revisions revision
      JOIN btcc_checkpoints checkpoint
        ON checkpoint.checkpoint_id = revision.checkpoint_id
      WHERE checkpoint.semantic_state = 'contract_review'
        AND revision.phase_envelope_json IS NOT NULL
      ORDER BY checkpoint.turn_revision, revision.checkpoint_revision
      LIMIT 1
    `).get();
    const state = JSON.parse(row!.phase_envelope_json).context.stateInput;
    expect(state.availableGoverningSpecs).toMatchObject([{
      logicalId: "SPEC-HARNESS",
      title: "Harness behavior",
    }]);
    expect(state.availableGoverningSpecs[0]).not.toHaveProperty("body");
    expect(state.selectedGoverningSpecs).toMatchObject([{
      logicalId: "SPEC-HARNESS",
      body: expect.stringContaining("Preserve the original request"),
    }]);
  } finally {
    db.close();
  }
}, 15_000);

async function runRevalidation(projectRef?: string) {
  const dataRoot = mkdtempSync(join(tmpdir(), "butler-btcc-revalidation-"));
  roots.push(dataRoot);
  const harness = resolve(
    import.meta.dir,
    "../../packages/butler-agent/src/interfaces/btcc-harness/run-btcc-harness.ts",
  );
  const child = Bun.spawn([
    process.execPath,
    "run",
    harness,
    "--data", dataRoot,
    "--turn", "turn-governing-revalidation",
    "--session", "session-governing-revalidation",
    "--message", "완료된 조사 결과도 변경된 기준에 맞춰 다시 검토해줘.",
    "--provider", "harness",
    "--model", "managed-v1",
    "--effort", "medium",
    "--scenario", "managed-governing-revalidation",
    ...(projectRef ? ["--project-ref", projectRef] : []),
  ], {
    cwd: resolve(import.meta.dir, "../.."),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  const result = JSON.parse(stdout) as {
    initial: { kind: string };
    phases: string[];
  };
  return { dataRoot, result };
}

function expectRevalidationPhases(phases: string[]): void {
  expect(phases.filter((phase) => phase === "task_execution")).toHaveLength(3);
  expect(phases.filter((phase) => phase === "task_review")).toHaveLength(4);
}
