import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a read-only validation correction reopens the owning implementation Task", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "butler-btcc-readonly-routing-"));
  roots.push(dataRoot);
  const result = await runScenario(dataRoot);

  expect(result.initial.kind).toBe("delivered");
  expect(result.phases.filter((phase) => phase === "feedback_conception")).toHaveLength(2);
  expect(result.phases.filter((phase) => phase === "feedback_planning")).toHaveLength(2);

  const db = new Database(join(dataRoot, "runtime", "btcc-successor.sqlite"), {
    readonly: true,
  });
  try {
    const plans = db.query<{ content_json: string }, []>(`
      SELECT content_json FROM btcc_records
      WHERE kind = 'feedback_plan_candidate' ORDER BY rowid
    `).all().map((row) => JSON.parse(row.content_json));

    expect(plans).toHaveLength(2);
    expect(plans[0]).toMatchObject({
      correctionKind: "implementation_repair",
      correctionPlan: {
        executionRequirement: { kind: "workspace_mutation", writablePaths: ["guide.md"] },
      },
    });
    expect(plans[1]).toMatchObject({
      correctionKind: "governing_revision",
      correctionPlan: {
        executionRequirement: { kind: "workspace_mutation", writablePaths: ["guide.md"] },
      },
      impactMap: [
        { disposition: "rework" },
        { disposition: "rework" },
        { disposition: "rework" },
      ],
    });

    expect(db.query<{ status: string }, []>(`
      SELECT status FROM btcc_tasks WHERE is_active = 1 ORDER BY rowid
    `).all()).toEqual([{ status: "accepted" }, { status: "accepted" }, { status: "accepted" }]);
    expect(db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM btcc_attempts WHERE correction_plan_ref IS NOT NULL
    `).get()?.count).toBe(1);
    expect(db.query<{ frontier: string }, []>(`
      SELECT frontier FROM btcc_programs
    `).get()?.frontier).toBe("closed");
    expect(db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM btcc_records WHERE kind LIKE '%deferral%'
    `).get()?.count).toBe(0);
  } finally {
    db.close();
  }
}, 30_000);

async function runScenario(dataRoot: string) {
  const harness = resolve(
    import.meta.dir,
    "../../packages/butler-agent/src/interfaces/btcc-harness/run-btcc-harness.ts",
  );
  const child = Bun.spawn([
    process.execPath,
    "run",
    harness,
    "--data", dataRoot,
    "--turn", "turn-readonly-mutation-routing",
    "--session", "session-readonly-mutation-routing",
    "--message", "읽기 전용 검증에서 수정이 발견되면 구현 작업을 다시 열어 완료해줘.",
    "--provider", "harness",
    "--model", "managed-v1",
    "--effort", "medium",
    "--scenario", "managed-readonly-mutation-routing",
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
  return JSON.parse(stdout) as {
    initial: { kind: string };
    phases: string[];
  };
}
