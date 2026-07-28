import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectWorkLedgerPublicationAdapter } from
  "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/index.ts";
import { openBtccSqliteStores } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { phaseGuidanceRevisionRef } from "../../packages/butler-agent/src/agent/btcc/guidance/index.ts";
import { scheduleRetrospective } from "../../packages/butler-agent/src/agent/btcc/delivery/index.ts";
import { runBtccRetrospective } from "../../packages/butler-agent/src/agent/cognition/retrospective/index.ts";
import { createBtccComposition } from "../../packages/butler-agent/src/agent/composition/index.ts";
import { DirectHarnessModel } from "../../packages/butler-agent/src/interfaces/btcc-harness/direct-harness-model.ts";
import { HarnessArtifactWorkspace } from "../../packages/butler-agent/src/interfaces/btcc-harness/harness-artifact-workspace.ts";
import { HarnessOperationExecutor } from "../../packages/butler-agent/src/interfaces/btcc-harness/harness-operation-executor.ts";
import {
  clearProjectFixtures,
  projectFixture,
} from "./support/btcc-project-ledger-fixture.ts";

test("retrospective scheduling failure cannot revoke an already delivered Turn", () => {
  expect(() => scheduleRetrospective({
    turn: {
      semanticState: "delivered",
      finalPayload: { content: "delivered" },
    } as never,
    scheduler: {
      schedule() {
        throw new Error("scheduler unavailable");
      },
    },
  })).not.toThrow();
});

test("delivered BTCC trajectories are evaluated, consolidated, and published asynchronously", async () => {
  const project = await projectFixture();
  const root = project.root;
  const dbPath = join(root, "btcc.sqlite");
  const runtime = createBtccComposition({
    dbPath,
    ownerId: "retrospective-test",
    model: new DirectHarnessModel(),
    operations: new HarnessOperationExecutor(root),
    artifacts: new HarnessArtifactWorkspace(),
    projectLedger: {
      publications: createProjectWorkLedgerPublicationAdapter({
        stagingRoot: join(root, "project-publications"),
      }),
      resolveProjectRoot: () => project.ledgerRoot,
    },
  });
  try {
    const outcome = await runtime.handle({
      kind: "run",
      turnId: "turn-retrospective",
      sessionId: "session-retrospective",
      triggerKey: "message:retrospective",
      message: { messageId: "message-retrospective", content: "안녕?" },
      modelSelection: {
        provider: "harness",
        model: "direct-v1",
        reasoningEffort: "low",
        controls: { reasoningEffort: "low" },
        controlsHash: "controls-hash",
      },
      context: {
        userRef: "user-1",
        projectRef: "project-1",
        profileRefs: [],
        recentFeedbackRefs: [],
        mandatoryHotCacheRefs: [],
        optionalHotCacheRefs: [],
        baselineObservationScopeRefs: [`workspace:${root}`],
      },
    });
    expect(outcome.kind).toBe("delivered");
    await Promise.resolve();
    const projectionGap = new Database(dbPath);
    try {
      expect(projectionGap.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_learning_sources",
      ).get()).toEqual({ count: 1 });
      const source = projectionGap.query<{ source_id: string }, []>(
        "SELECT source_id FROM btcc_learning_sources",
      ).get()!;
      projectionGap.query(`
        INSERT INTO btcc_retrospective_decisions (source_id, decisions_json, created_at)
        VALUES (?, ?, ?)
      `).run(
        source.source_id,
        JSON.stringify({ decisions: [] }),
        new Date().toISOString(),
      );
      expect(projectionGap.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_phase_model_rounds",
      ).get()!.count).toBeGreaterThan(0);
      projectionGap.exec("DELETE FROM btcc_learning_candidate_outbox; DELETE FROM btcc_learning_sources;");
    } finally {
      projectionGap.close();
    }
    const guidanceStores = openBtccSqliteStores({
      dbPath,
      ownerId: "retrospective-guidance",
    });
    const existingGuidance = guidanceStores.phaseGuidance.publish({
      disposition: "promote",
      guidance: {
        guidanceId: "opening-understand-before-answering",
        phase: "conception_opening",
        scope: { kind: "project", projectRef: "project-1" },
        scopeRationale: "The initial guidance was project-bound.",
        scopeSourceRefs: ["prior-source"],
        generalityBoundary: "project_bound_strategy",
        guidance: "Check intent before answering.",
        appliesWhen: ["a project request begins"],
        doesNotApplyWhen: [],
        sourceIds: ["prior-source"],
      },
    });
    guidanceStores.close();

    const calls: Array<{ kind: string; prompt: string }> = [];
    const result = await runBtccRetrospective({
      butlerData: root,
      dbPath,
      modelRunner: async (input) => {
        calls.push({ kind: input.kind, prompt: input.prompt });
        return input.kind === "evaluate"
          ? JSON.stringify(retrospectiveOutput())
          : JSON.stringify({
              contractRevision: "btcc.guidance-decision.v1",
              decisions: [{
                candidateId: "candidate-opening-care",
                disposition: "merge",
                guidanceId: "opening-understand-before-answering",
                rationale: "The lesson is phase-local and reusable.",
                targetRevision: phaseGuidanceRevisionRef(existingGuidance),
                acceptedScopeKind: "project",
                acceptedScopeRationale: "Consolidation narrowed the lesson to this project.",
                acceptedScopeSourceRefs: ["turn-retrospective"],
                acceptedGeneralityBoundary: "project_bound_strategy",
                acceptedGuidance:
                  "Confirm the user's intended result without slowing a direct answer.",
                acceptedAppliesWhen: ["the request needs a concise opening"],
                acceptedDoesNotApplyWhen: ["the intent is genuinely ambiguous"],
              }],
            });
      },
    });

    expect(result).toMatchObject({
      pending_count: 1,
      processed_count: 1,
      failed_count: 0,
      promoted_guidance_count: 1,
    });
    expect(calls.map(({ kind }) => kind)).toEqual(["evaluate", "consolidate"]);
    const evaluationPrompt = JSON.parse(calls[0]!.prompt);
    expect(evaluationPrompt.trajectory.originalRequest).toBe("안녕?");
    expect(evaluationPrompt.trajectory.phaseProducts.length).toBeGreaterThan(0);

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query<{ status: string }, []>(
        "SELECT status FROM btcc_learning_candidate_outbox",
      ).get()).toEqual({ status: "processed" });
      const guidance = db.query<{
        phase: string;
        scope_kind: string;
        revision: number;
        guidance_json: string;
      }, []>(`
        SELECT phase, scope_kind, revision, guidance_json
        FROM btcc_phase_guidance WHERE status = 'active'
      `).get();
      expect(guidance).toMatchObject({
        phase: "conception_opening",
        scope_kind: "project",
        revision: 2,
      });
      const storedGuidance = JSON.parse(guidance!.guidance_json);
      expect(storedGuidance).toMatchObject({
        guidance: "Confirm the user's intended result without slowing a direct answer.",
        scopeRationale: "Consolidation narrowed the lesson to this project.",
        scopeSourceRefs: ["prior-source", "turn-retrospective"],
        generalityBoundary: "project_bound_strategy",
        revisionKind: "merge",
        predecessor: phaseGuidanceRevisionRef(existingGuidance),
        appliesWhen: ["the request needs a concise opening"],
        doesNotApplyWhen: ["the intent is genuinely ambiguous"],
      });
      expect(storedGuidance.sourceIds).toContain("prior-source");
      expect(storedGuidance.sourceIds).toHaveLength(2);
    } finally {
      db.close();
    }

    const replay = await runBtccRetrospective({
      butlerData: root,
      dbPath,
      modelRunner: async () => {
        throw new Error("processed sources must not be evaluated again");
      },
    });
    expect(replay.pending_count).toBe(0);
  } finally {
    clearProjectFixtures();
  }
});

test("retrospective model failure stays pending and cannot reopen the delivered turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-retrospective-failure-"));
  const dbPath = join(root, "btcc.sqlite");
  seedDeliveredSource(dbPath);
  try {
    const result = await runBtccRetrospective({
      butlerData: root,
      dbPath,
      modelRunner: async () => "not-json",
    });
    expect(result).toMatchObject({ processed_count: 0, failed_count: 1 });
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query<{ status: string }, []>(
        "SELECT status FROM btcc_learning_candidate_outbox",
      ).get()).toEqual({ status: "pending" });
      expect(db.query<{ semantic_state: string }, []>(
        "SELECT semantic_state FROM btcc_turns",
      ).get()).toEqual({ semantic_state: "delivered" });
      expect(db.query<{ attempt_count: number }, []>(
        "SELECT attempt_count FROM btcc_learning_diagnostics",
      ).get()).toEqual({ attempt_count: 1 });
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retrospective publishes reviewed session and global phase guidance", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-retrospective-scopes-"));
  const dbPath = join(root, "btcc.sqlite");
  seedDeliveredSource(dbPath);
  try {
    const output = retrospectiveOutput("turn-failure");
    output.candidates = [
      {
        ...output.candidates[0]!,
        candidateId: "candidate-session",
        scopeKind: "session",
        scopeRationale: "The evidence applies only to this conversation session.",
        generalityBoundary: "session_bound_strategy",
      },
      {
        ...output.candidates[0]!,
        candidateId: "candidate-global",
        scopeKind: "global",
        scopeRationale: "The evidence supports stable phase practice across contexts.",
        generalityBoundary: "global_phase_practice",
      },
    ];
    const result = await runBtccRetrospective({
      butlerData: root,
      dbPath,
      modelRunner: async (input) => input.kind === "evaluate"
        ? JSON.stringify(output)
        : JSON.stringify({
            contractRevision: "btcc.guidance-decision.v1",
            decisions: [
              acceptedScopeDecision("candidate-session", "session", "session_bound_strategy"),
              acceptedScopeDecision("candidate-global", "global", "global_phase_practice"),
            ],
          }),
    });
    expect(result).toMatchObject({ processed_count: 1, promoted_guidance_count: 2 });
    const stores = openBtccSqliteStores({ dbPath, ownerId: "scope-reader" });
    try {
      expect(stores.phaseGuidance.list({
        phase: "conception_opening",
        userRef: "user-1",
        sessionId: "session-failure",
      }).map(({ scope }) => scope)).toEqual([
        { kind: "session", sessionId: "session-failure" },
        { kind: "global" },
      ]);
    } finally {
      stores.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid retrospective candidate identity and source refs stay pending", async () => {
  for (const invalid of [
    "duplicate_candidate",
    "dangling_source_ref",
    "missing_revision_target",
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), `btcc-retrospective-${invalid}-`));
    const dbPath = join(root, "btcc.sqlite");
    seedDeliveredSource(dbPath);
    try {
      const output = retrospectiveOutput("turn-failure");
      if (invalid === "duplicate_candidate") output.candidates.push({ ...output.candidates[0]! });
      if (invalid === "dangling_source_ref") {
        output.candidates[0]!.scopeSourceRefs = ["unknown-trajectory-ref"];
      }
      const result = await runBtccRetrospective({
        butlerData: root,
        dbPath,
        modelRunner: async (input) => {
          if (input.kind === "evaluate") return JSON.stringify(output);
          return JSON.stringify({
            contractRevision: "btcc.guidance-decision.v1",
            decisions: [{
              candidateId: "candidate-opening-care",
              disposition: "merge",
              guidanceId: "missing-guidance",
              rationale: "This target was not supplied as active guidance.",
              targetRevision: {
                guidanceId: "missing-guidance",
                phase: "conception_opening",
                scope: { kind: "user", userRef: "user-1" },
                revision: 1,
                contentSha256: "missing-hash",
              },
              acceptedScopeKind: "user",
              acceptedScopeRationale: "The source supports a user preference.",
              acceptedScopeSourceRefs: ["turn-failure"],
              acceptedGeneralityBoundary: "cross_project_user_preference",
              acceptedGuidance: "Use a deliberate opening.",
              acceptedAppliesWhen: ["a deliberate opening is useful"],
              acceptedDoesNotApplyWhen: [],
            }],
          });
        },
      });
      expect(result).toMatchObject({ processed_count: 0, failed_count: 1 });
      const db = new Database(dbPath, { readonly: true });
      try {
        expect(db.query<{ status: string }, []>(
          "SELECT status FROM btcc_learning_candidate_outbox",
        ).get()).toEqual({ status: "pending" });
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function retrospectiveOutput(sourceRef = "turn-retrospective") {
  const finding = { score: 4, assessment: "Adequate with a reusable improvement.", sourceRefs: [sourceRef] };
  return {
    rubricRevision: "btcc.retrospective-rubric.v1" as const,
    summary: "The turn completed faithfully.",
    dimensions: {
      goal_fidelity: finding,
      conception_quality: finding,
      planning_quality: finding,
      ledger_fitness: finding,
      execution_fidelity: finding,
      review_effectiveness: finding,
      efficiency_and_proportionality: finding,
      user_stewardship: finding,
      learning_calibration: finding,
    },
    strengths: ["The answer was direct."],
    misses: ["The opening can state its intent more deliberately."],
    candidates: [{
      candidateId: "candidate-opening-care",
      phase: "conception_opening",
      scopeKind: "user",
      scopeRationale: "The user's requested interaction style applies across projects.",
      scopeSourceRefs: [sourceRef],
      generalityBoundary: "cross_project_user_preference",
      problem: "The opening can miss a deliberate intent check.",
      guidance: "Confirm the user's intended result before composing a direct answer.",
      appliesWhen: ["a direct answer is appropriate"],
      doesNotApplyWhen: ["the user intent is genuinely ambiguous"],
      expectedBenefit: "More faithful direct answers.",
      risks: ["Do not make the first answer slower."],
      confidence: 0.8,
      sourceRefs: [sourceRef],
    }],
    outsideLearningSurface: [],
  };
}

function acceptedScopeDecision(
  candidateId: string,
  scopeKind: "session" | "global",
  boundary: "session_bound_strategy" | "global_phase_practice",
) {
  return {
    candidateId,
    disposition: "promote",
    guidanceId: `guidance-${scopeKind}`,
    rationale: "The reviewed evidence supports this exact scope.",
    acceptedScopeKind: scopeKind,
    acceptedScopeRationale: "The accepted scope is explicitly supported by this trajectory.",
    acceptedScopeSourceRefs: ["turn-failure"],
    acceptedGeneralityBoundary: boundary,
    acceptedGuidance: "Preserve the accepted phase contract while improving phase-local strategy.",
    acceptedAppliesWhen: ["the phase contract remains unchanged"],
    acceptedDoesNotApplyWhen: ["the lesson would change algorithm or model selection"],
  };
}

function seedDeliveredSource(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE btcc_turns (turn_id TEXT PRIMARY KEY, session_id TEXT, original_message TEXT, context_json TEXT,
        managed_state_json TEXT, opening_answer_json TEXT,
        final_payload_json TEXT, semantic_state TEXT);
      CREATE TABLE btcc_learning_sources (source_id TEXT PRIMARY KEY, turn_id TEXT, source_json TEXT);
      CREATE TABLE btcc_learning_candidate_outbox (outbox_id TEXT PRIMARY KEY, source_id TEXT, status TEXT);
      CREATE TABLE btcc_checkpoints (turn_id TEXT, semantic_state TEXT, turn_revision INTEGER, accepted_product_json TEXT);
      CREATE TABLE btcc_records (record_id TEXT, content_json TEXT);
      CREATE TABLE btcc_context_documents (context_ref TEXT, content TEXT);
    `);
    db.query("INSERT INTO btcc_turns VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)").run(
      "turn-failure", "session-failure", "hello", JSON.stringify({ userRef: "user-1" }),
      JSON.stringify({ content: "hello" }), "delivered",
    );
    db.query("INSERT INTO btcc_learning_sources VALUES (?, ?, ?)").run(
      "source-failure", "turn-failure", JSON.stringify({ turnId: "turn-failure", recentFeedbackRefs: [] }),
    );
    db.query("INSERT INTO btcc_learning_candidate_outbox VALUES (?, ?, 'pending')").run(
      "outbox-failure", "source-failure",
    );
  } finally {
    db.close();
  }
}
