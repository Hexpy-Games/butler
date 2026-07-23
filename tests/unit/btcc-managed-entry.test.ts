import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProjectWorkLedgerPublicationAdapter } from
  "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/index.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("BTCC managed executable ingress", () => {
  test.each([
    ["managed-pass", 11, 2],
    ["managed-review-repair", 16, 3],
    ["managed-planning-revision", 13, 2],
    ["managed-goal-revision", 13, 2],
    ["managed-feedback-planning-revision", 18, 3],
    ["managed-governing-revision", 16, 3],
    ["managed-authority-revision", 16, 3],
  ] as const)("completes %s through the same Turn entry", async (
    scenario,
    expectedModelCalls,
    expectedAttempts,
  ) => {
    const dataRoot = mkdtempSync(join(tmpdir(), `butler-btcc-${scenario}-`));
    temporaryRoots.push(dataRoot);
    const harness = resolve(
      import.meta.dir,
      "../../packages/butler-agent/src/interfaces/btcc-harness/run-btcc-harness.ts",
    );
    const turnId = `turn-${scenario}`;

    const child = Bun.spawn([
      process.execPath,
      "run",
      harness,
      "--data", dataRoot,
      "--turn", turnId,
      "--session", `session-${scenario}`,
      "--message", "고객 응대 원칙을 조사해서 짧은 운영 가이드를 작성해줘.",
      "--provider", "harness",
      "--model", "managed-v1",
      "--effort", "medium",
      "--profile-ref", "profile:concise",
      "--hot-cache-ref", "cache:preserve-original-intent",
      "--scenario", scenario,
      "--replay",
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

    const result = JSON.parse(stdout.trim()) as {
      initial: { kind: string; messageId: string; content: string };
      replay: { kind: string; messageId: string; content: string };
      modelCalls: number;
      phases: string[];
    };
    expect(result.initial.kind).toBe("delivered");
    expect(result.replay).toEqual(result.initial);
    expect(result.modelCalls).toBe(expectedModelCalls);
    const initialPlanning = [
      "conception_opening", "conception_deliberation", "contract_review",
      "planning", "planning_review",
    ];
    const reviewedPlanning = scenario === "managed-planning-revision"
      ? [...initialPlanning, "planning", "planning_review"]
      : scenario === "managed-goal-revision"
        ? [
            "conception_opening", "conception_deliberation", "contract_review",
            "conception_deliberation", "contract_review", "planning", "planning_review",
          ]
        : initialPlanning;
    const firstTask = [...reviewedPlanning, "task_execution", "task_review"];
    const repairCycle = scenario === "managed-feedback-planning-revision"
      ? [
          "feedback_conception", "feedback_planning", "feedback_planning_review",
          "feedback_planning", "feedback_planning_review",
        ]
      : ["feedback_conception", "feedback_planning", "feedback_planning_review"];
    const needsRepair = scenario === "managed-review-repair" ||
      scenario === "managed-feedback-planning-revision" ||
      scenario === "managed-governing-revision" ||
      scenario === "managed-authority-revision";
    expect(result.phases).toEqual([
      ...firstTask,
      ...(needsRepair ? repairCycle : []),
      ...(needsRepair ? ["task_execution", "task_review"] : []),
      "task_execution", "task_review", "consolidation", "reporting",
    ]);
    if (needsRepair) {
      expect(result.phases).toContain("feedback_conception");
      expect(result.phases).toContain("feedback_planning");
      expect(result.phases).toContain("feedback_planning_review");
    }

    const db = new Database(join(dataRoot, "runtime", "btcc-successor.sqlite"), {
      readonly: true,
    });
    try {
      const turn = db.query<{
        semantic_state: string;
        route: string;
        goal_contract_ref: string;
        final_dossier_ref: string;
        managed_state_json: string;
      }, [string]>(`
        SELECT semantic_state, route, goal_contract_ref, final_dossier_ref,
          managed_state_json
        FROM btcc_turns WHERE turn_id = ?
      `).get(turnId);
      const program = db.query<{
        goal_contract_ref: string;
        frontier: string;
        scope_kind: string;
        manifest_revision: number;
      }, []>(`
        SELECT goal_contract_ref, frontier, scope_kind, manifest_revision
        FROM btcc_programs
      `).get();
      const tasks = db.query<{ status: string }, []>(
        "SELECT status FROM btcc_tasks WHERE is_active = 1 ORDER BY rowid",
      ).all();
      const attempts = db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_attempts",
      ).get();
      const ledgerMutations = db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_ledger_mutations",
      ).get();
      const promotedClaims = db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM btcc_ledger_claims WHERE status = 'promoted'
      `).get();
      const openingProjection = db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_opening_projections",
      ).get();
      const reviewRecords = db.query<{ content_json: string }, []>(
        "SELECT content_json FROM btcc_records WHERE kind = 'task_review' ORDER BY rowid",
      ).all();
      const dossierRecord = db.query<{ content_json: string }, []>(
        "SELECT content_json FROM btcc_records WHERE kind = 'final_dossier'",
      ).get();
      const attemptRows = db.query<{
        attempt_id: string;
        previous_attempt_id: string | null;
        correction_plan_ref: string | null;
      }, []>(`
        SELECT attempt_id, previous_attempt_id, correction_plan_ref
        FROM btcc_attempts ORDER BY rowid
      `).all();
      const planningCandidates = db.query<{ content_json: string }, []>(`
        SELECT content_json FROM btcc_records WHERE kind = 'plan_candidate' ORDER BY rowid
      `).all().map((row) => JSON.parse(row.content_json));
      const goalCandidates = db.query<{ content_json: string }, []>(`
        SELECT content_json FROM btcc_records
        WHERE kind = 'goal_contract_candidate' ORDER BY rowid
      `).all().map((row) => JSON.parse(row.content_json));
      const feedbackCandidates = db.query<{ content_json: string }, []>(`
        SELECT content_json FROM btcc_records
        WHERE kind = 'feedback_plan_candidate' ORDER BY rowid
      `).all().map((row) => JSON.parse(row.content_json));
      const phaseInputs = new Map(db.query<{
        semantic_state: string;
        phase_envelope_json: string;
      }, [string]>(`
        SELECT checkpoint.semantic_state, revision.phase_envelope_json
        FROM btcc_phase_checkpoint_revisions revision
        JOIN btcc_checkpoints checkpoint
          ON checkpoint.checkpoint_id = revision.checkpoint_id
        WHERE checkpoint.turn_id = ? AND revision.phase_envelope_json IS NOT NULL
        ORDER BY checkpoint.turn_revision, revision.checkpoint_revision
      `).all(turnId).map((row) => [
        row.semantic_state,
        JSON.parse(row.phase_envelope_json).context.stateInput,
      ]));

      expect(turn?.semantic_state).toBe("delivered");
      expect(turn?.route).toBe("managed");
      expect(turn?.goal_contract_ref).toBe(program?.goal_contract_ref);
      expect(turn?.final_dossier_ref).toBeTruthy();
      const persistedManaged = JSON.parse(turn!.managed_state_json);
      expect(persistedManaged.program).toBeUndefined();
      expect(persistedManaged.programId).toBeTruthy();
      expect(program?.frontier).toBe("closed");
      expect(program?.scope_kind).toBe("session");
      const expectedManifestRevision = needsRepair ? 13 : 9;
      expect(program?.manifest_revision).toBe(expectedManifestRevision);
      expect(ledgerMutations?.count).toBe(expectedManifestRevision);
      expect(promotedClaims?.count).toBe(expectedManifestRevision);
      expect(tasks).toEqual([{ status: "accepted" }, { status: "accepted" }]);
      expect(attempts?.count).toBe(expectedAttempts);
      expect(openingProjection?.count).toBe(1);
      for (const record of reviewRecords) {
        expect(JSON.parse(record.content_json).goalContractRef.id).toBe(turn!.goal_contract_ref);
      }
      expect(JSON.parse(dossierRecord!.content_json).originalGoalContractRef.id)
        .toBe(turn!.goal_contract_ref);
      expect(planningCandidates.at(-1)?.works).toHaveLength(1);
      expect(planningCandidates.at(-1)?.tasks).toHaveLength(2);
      expect(planningCandidates[0]?.observedManifestRevision).toBe(1);
      expect(phaseInputs.get("planning")).toMatchObject({
        acceptedGoalContract: { request: expect.any(String) },
        acceptedAuthority: { route: "managed" },
      });
      expect(phaseInputs.get("task_execution")).toMatchObject({
        acceptedGoalContract: { request: expect.any(String) },
        acceptedPlan: { strategy: expect.any(String) },
        currentTask: { intendedOutcome: expect.any(String) },
      });
      expect(phaseInputs.get("task_review")).toMatchObject({
        acceptedGoalContract: { request: expect.any(String) },
        currentWork: { outcome: expect.any(String) },
        currentTask: { intendedOutcome: expect.any(String) },
      });
      expect(phaseInputs.get("consolidation")).toMatchObject({
        acceptedGoalContract: { request: expect.any(String) },
        acceptedPlan: { strategy: expect.any(String) },
        managedTasks: expect.any(Array),
      });
      if (scenario === "managed-planning-revision") {
        expect(planningCandidates).toHaveLength(2);
        expect(planningCandidates[1]?.revisionOrigin).toEqual({
          kind: "review_revision",
          previousCandidateRef: planningCandidates[0]?.ref,
          findingSetRef: expect.any(Object),
        });
      }
      if (scenario === "managed-goal-revision") {
        expect(goalCandidates).toHaveLength(2);
        expect(goalCandidates[1]?.revisionOrigin).toEqual({
          kind: "review_revision",
          previousCandidateRef: goalCandidates[0]?.ref,
          reviewRef: expect.any(Object),
          findingSetRef: expect.any(Object),
        });
        expect(phaseInputs.get("conception_deliberation")).toMatchObject({
          goalRevision: {
            kind: "goal_contract_revision_required",
            review: { findings: [expect.stringContaining("원래 요청")] },
          },
        });
      }
      if (scenario === "managed-feedback-planning-revision") {
        expect(feedbackCandidates).toHaveLength(2);
        expect(feedbackCandidates[1]?.revisionOrigin.kind).toBe("review_revision");
      }
      if (scenario === "managed-governing-revision" || scenario === "managed-authority-revision") {
        expect(planningCandidates.at(-1)?.observedManifestRevision).toBe(5);
        expect(feedbackCandidates.at(-1)?.impactMap).toHaveLength(2);
        expect(feedbackCandidates.at(-1)?.nextPlanCandidate.tasks).toHaveLength(2);
        const inactive = db.query<{ count: number }, []>(`
          SELECT COUNT(*) AS count FROM btcc_tasks WHERE is_active = 0
        `).get();
        expect(inactive?.count).toBeGreaterThan(0);
      }
      if (needsRepair && scenario !== "managed-governing-revision" &&
          scenario !== "managed-authority-revision") {
        expect(attemptRows[1]?.previous_attempt_id).toBe(attemptRows[0]?.attempt_id);
        expect(attemptRows[1]?.correction_plan_ref).toBeTruthy();
        const inactive = db.query<{ count: number }, []>(`
          SELECT COUNT(*) AS count FROM btcc_tasks WHERE is_active = 0
        `).get();
        expect(inactive?.count).toBe(0);
      }
      if (scenario === "managed-governing-revision" || scenario === "managed-authority-revision") {
        expect(attemptRows[1]?.previous_attempt_id).toBeNull();
        expect(attemptRows[1]?.correction_plan_ref).toBeTruthy();
      }
    } finally {
      db.close();
    }
  });

  test("binds project work from structural context without changing the algorithm", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "butler-btcc-project-ledger-"));
    temporaryRoots.push(dataRoot);
    const harness = resolve(
      import.meta.dir,
      "../../packages/butler-agent/src/interfaces/btcc-harness/run-btcc-harness.ts",
    );
    const child = Bun.spawn([
      process.execPath,
      "run",
      harness,
      "--data", dataRoot,
      "--turn", "turn-project-managed",
      "--session", "session-project-managed",
      "--project-ref", "project:sandybot",
      "--message", "운영 가이드를 조사해서 작성해줘.",
      "--provider", "harness",
      "--model", "managed-v1",
      "--effort", "medium",
      "--scenario", "managed-pass",
    ], { cwd: resolve(import.meta.dir, "../.."), stderr: "pipe", stdout: "pipe" });
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain('"kind":"delivered"');

    const db = new Database(join(dataRoot, "runtime", "btcc-successor.sqlite"), {
      readonly: true,
    });
    try {
      const projection = db.query<{
        program_id: string;
        project_ref: string;
        manifest_revision: number;
      }, []>(`
        SELECT program_id, project_ref, manifest_revision
        FROM btcc_project_program_projections
      `).get();
      expect(projection?.project_ref).toBe("project:sandybot");
      expect(projection?.manifest_revision).toBe(9);
      const adapter = createProjectWorkLedgerPublicationAdapter({
        stagingRoot: join(dataRoot, "runtime", "btcc-project-ledger-publications"),
      });
      const canonical = await adapter.loadProgram(
        join(dataRoot, "project-ledger", "projects", "project-workspace"),
        projection!.program_id,
      );
      expect(canonical?.manifestRevision).toBe(9);
      expect(canonical?.planningState).toBe("reviewed");
    } finally {
      db.close();
    }
  });

});
