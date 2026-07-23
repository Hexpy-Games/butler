import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProjectWorkLedgerPublicationAdapter } from
  "../../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/index.ts";

test("Project Work Ledger uses the single-Consolidation promotion path", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "butler-btcc-project-artifact-"));
  try {
    const child = Bun.spawn([
      process.execPath,
      "run",
      resolve(
        import.meta.dir,
        "../../../packages/butler-agent/src/interfaces/btcc-harness/run-btcc-harness.ts",
      ),
      "--data", dataRoot,
      "--turn", "turn-project-artifact",
      "--session", "session-project-artifact",
      "--project-ref", "project:artifact",
      "--message", "프로젝트 격리 작업을 검토하고 승인된 결과만 반영해줘.",
      "--provider", "openai",
      "--model", "gpt-5.6-sol",
      "--effort", "low",
      "--scenario", "managed-artifact",
    ], {
      cwd: resolve(import.meta.dir, "../../.."),
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
    const result = JSON.parse(stdout.trim());
    expect(result.initial.kind).toBe("delivered");
    expect(result.phases.filter((phase: string) => phase === "consolidation")).toHaveLength(1);

    const db = new Database(join(dataRoot, "runtime", "btcc-successor.sqlite"), {
      readonly: true,
    });
    try {
      expect(db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM btcc_records WHERE kind = 'promotion_permit'
      `).get()).toEqual({ count: 1 });
      const projection = db.query<{ program_id: string; manifest_revision: number }, []>(`
        SELECT program_id, manifest_revision FROM btcc_project_program_projections
      `).get();
      expect(projection?.manifest_revision).toBe(17);
      const publications = createProjectWorkLedgerPublicationAdapter({
        stagingRoot: join(dataRoot, "runtime", "btcc-project-ledger-publications"),
      });
      const program = await publications.loadProgram(
        join(dataRoot, "project-ledger", "projects", "project-workspace"),
        projection!.program_id,
      );
      expect(program?.planningState).toBe("reviewed");
      if (!program || program.planningState !== "reviewed") {
        throw new Error("Project Work Ledger did not retain its reviewed Program");
      }
      expect(program.frontier).toBe("closed");
      expect(program.promotionPermit?.basis)
        .toBe("accepted_implementation_and_integration_reviews");
    } finally {
      db.close();
    }
  } finally {
    rmSync(dataRoot, { force: true, recursive: true });
  }
}, 15_000);
