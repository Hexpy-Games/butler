import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installCompleteRoot } from
  "../../packages/butler-agent/src/foundation/atomic-root-exchange.ts";
import { captureTargetSnapshot } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/operations/target-snapshot.ts";

test("represents an absent baseline and atomically installs its first complete target", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-btcc-absent-target-"));
  try {
    const target = join(root, "btcc");
    const stage = join(root, ".btcc-stage");
    expect(captureTargetSnapshot(target).targetState).toBe("absent");

    mkdirSync(stage);
    writeFileSync(join(stage, "index.ts"), "export const ready = true;\n");
    const candidate = captureTargetSnapshot(stage);
    installCompleteRoot(stage, target);

    expect(captureTargetSnapshot(target)).toEqual(candidate);
    expect(readFileSync(join(target, "index.ts"), "utf8"))
      .toBe("export const ready = true;\n");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("keeps artifact work isolated until Consolidation authorizes promotion", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "butler-btcc-artifact-"));
  try {
    const harness = resolve(
      import.meta.dir,
      "../../packages/butler-agent/src/interfaces/btcc-harness/run-btcc-harness.ts",
    );
    const args = [
      process.execPath,
      "run",
      harness,
      "--data", dataRoot,
      "--turn", "turn-artifact-lifecycle",
      "--session", "session-artifact-lifecycle",
      "--message", "격리해서 변경하고 검증한 뒤 승인된 결과만 반영해줘.",
      "--provider", "openai",
      "--model", "gpt-5.6-sol",
      "--effort", "low",
      "--scenario", "managed-artifact",
      "--replay",
    ];
    const child = Bun.spawn(args, {
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
    const result = JSON.parse(stdout.trim());
    expect(result.initial.kind).toBe("delivered");
    expect(result.initial.content).toContain("변경:");
    expect(result.initial.content).toContain("검증:");
    expect(result.replay).toEqual(result.initial);
    expect(result.modelCalls).toBe(25);
    expect(result.operationCalls).toBe(7);
    expect(result.artifactSnapshot.promoted).toBe(result.artifactSnapshot.workspace["guide.md"]);
    expect(result.artifactSnapshot.promoted).toContain("격리 작업공간");
    expect(result.artifactSnapshot.promoted).not.toContain("workspace artifact:");
    expect(result.selectedModel).toEqual({
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
    });
    expect(result.phases.filter((phase: string) => phase === "consolidation")).toHaveLength(1);

    const db = new Database(join(dataRoot, "runtime", "btcc-successor.sqlite"), {
      readonly: true,
    });
    try {
      const program = db.query<{ frontier: string; manifest_revision: number }, []>(`
        SELECT frontier, manifest_revision FROM btcc_programs
      `).get();
      const tasks = db.query<{ task_kind: string; status: string }, []>(`
        SELECT task_kind, status FROM btcc_tasks WHERE is_active = 1 ORDER BY rowid
      `).all();
      const recordCounts = db.query<{ kind: string; count: number }, []>(`
        SELECT kind, COUNT(*) AS count FROM btcc_records
        WHERE kind IN (
          'program_artifact_workspace', 'workspace_revision',
          'reviewed_promotion_candidate', 'promotion_resolution_receipt',
          'promotion_authorization', 'final_dossier'
        ) GROUP BY kind ORDER BY kind
      `).all();
      const dossier = db.query<{ content_json: string }, []>(`
        SELECT content_json FROM btcc_records WHERE kind = 'final_dossier'
      `).get();
      const authorization = db.query<{ content_json: string }, []>(`
        SELECT content_json FROM btcc_records WHERE kind = 'promotion_authorization'
      `).get();
      const mutationKinds = db.query<{ mutation_kind: string }, []>(`
        SELECT mutation_kind FROM btcc_ledger_mutations ORDER BY next_manifest_revision
      `).all().map((row) => row.mutation_kind);
      const operationRequests = db.query<{ request_json: string }, []>(`
        SELECT request_json FROM btcc_phase_operation_results ORDER BY rowid
      `).all().map((row) => JSON.parse(row.request_json));
      const journalStates = db.query<{ content_json: string }, []>(`
        SELECT content_json FROM btcc_records
        WHERE kind = 'repository_promotion_journal' ORDER BY rowid
      `).all().map((row) => JSON.parse(row.content_json).state);

      expect(program).toEqual({ frontier: "closed", manifest_revision: 18 });
      expect(tasks).toEqual([
        { task_kind: "workspace_artifact", status: "accepted" },
        { task_kind: "workspace_artifact", status: "accepted" },
        { task_kind: "repository_promotion", status: "accepted" },
      ]);
      expect(recordCounts).toEqual([
        { kind: "final_dossier", count: 1 },
        { kind: "program_artifact_workspace", count: 1 },
        { kind: "promotion_authorization", count: 1 },
        { kind: "promotion_resolution_receipt", count: 1 },
        { kind: "reviewed_promotion_candidate", count: 1 },
        { kind: "workspace_revision", count: 3 },
      ]);
      const finalDossier = JSON.parse(dossier!.content_json);
      const promotionAuthorization = JSON.parse(authorization!.content_json);
      expect(finalDossier.promotionClosure).toBe("promoted");
      expect(finalDossier.userReport).toEqual(promotionAuthorization.userReport);
      expect(finalDossier.userReport.materialChanges).not.toBeEmpty();
      expect(finalDossier.userReport.validationResults).not.toBeEmpty();
      expect(mutationKinds.indexOf("close_implementation_frontier"))
        .toBeLessThan(mutationKinds.indexOf("authorize_promotion"));
      expect(mutationKinds.indexOf("authorize_promotion"))
        .toBeLessThan(mutationKinds.indexOf("close_promotion_frontier"));
      expect(operationRequests.filter((request) =>
        request.kind === "workspace_artifact_action")).toHaveLength(3);
      expect(operationRequests.filter((request) =>
        request.kind === "review_validation")).toHaveLength(3);
      expect(operationRequests.at(-1)?.kind).toBe("repository_promotion");
      expect(journalStates).toEqual([
        "prepared", "baseline_verified", "commit_intent_durable",
        "commit_observed", "closed",
      ]);
    } finally {
      db.close();
    }

    const restarted = Bun.spawn(args, {
      cwd: resolve(import.meta.dir, "../.."),
      stderr: "pipe",
      stdout: "pipe",
    });
    const [restartExit, restartOutput, restartError] = await Promise.all([
      restarted.exited,
      new Response(restarted.stdout).text(),
      new Response(restarted.stderr).text(),
    ]);
    expect(restartError).toBe("");
    expect(restartExit).toBe(0);
    const restartedResult = JSON.parse(restartOutput.trim());
    expect(restartedResult.modelCalls).toBe(0);
    expect(restartedResult.operationCalls).toBe(0);
    expect(restartedResult.artifactSnapshot.promoted).toBe(result.artifactSnapshot.promoted);
  } finally {
    rmSync(dataRoot, { force: true, recursive: true });
  }
});
