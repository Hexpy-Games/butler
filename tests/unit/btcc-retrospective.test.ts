import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBtccComposition } from "../../packages/butler-agent/src/agent/composition/index.ts";
import { runBtccRetrospective } from "../../packages/butler-agent/src/agent/cognition/retrospective/index.ts";
import { DirectHarnessModel } from "../../packages/butler-agent/src/interfaces/btcc-harness/direct-harness-model.ts";
import { HarnessArtifactWorkspace } from "../../packages/butler-agent/src/interfaces/btcc-harness/harness-artifact-workspace.ts";
import { HarnessOperationExecutor } from "../../packages/butler-agent/src/interfaces/btcc-harness/harness-operation-executor.ts";

test("delivered BTCC trajectories are evaluated, consolidated, and published asynchronously", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-retrospective-"));
  const dbPath = join(root, "btcc.sqlite");
  const runtime = createBtccComposition({
    dbPath,
    ownerId: "retrospective-test",
    model: new DirectHarnessModel(),
    operations: new HarnessOperationExecutor(root),
    artifacts: new HarnessArtifactWorkspace(),
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
      projectionGap.exec("DELETE FROM btcc_learning_candidate_outbox; DELETE FROM btcc_learning_sources;");
    } finally {
      projectionGap.close();
    }

    const calls: Array<{ kind: string; prompt: string }> = [];
    const result = await runBtccRetrospective({
      butlerData: root,
      dbPath,
      modelRunner: async (input) => {
        calls.push({ kind: input.kind, prompt: input.prompt });
        return input.kind === "evaluate"
          ? JSON.stringify(retrospectiveOutput())
          : JSON.stringify({
              decisions: [{
                candidateId: "candidate-opening-care",
                disposition: "promote",
                guidanceId: "opening-understand-before-answering",
                rationale: "The lesson is phase-local and reusable.",
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
      const guidance = db.query<{ phase: string; scope_kind: string; revision: number }, []>(`
        SELECT phase, scope_kind, revision FROM btcc_phase_guidance WHERE status = 'active'
      `).get();
      expect(guidance).toEqual({
        phase: "conception_opening",
        scope_kind: "user",
        revision: 1,
      });
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
    rmSync(root, { recursive: true, force: true });
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

function retrospectiveOutput() {
  const finding = { score: 4, assessment: "Adequate with a reusable improvement.", sourceRefs: ["turn-retrospective"] };
  return {
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
      problem: "The opening can miss a deliberate intent check.",
      guidance: "Confirm the user's intended result before composing a direct answer.",
      appliesWhen: ["a direct answer is appropriate"],
      doesNotApplyWhen: ["the user intent is genuinely ambiguous"],
      expectedBenefit: "More faithful direct answers.",
      risks: ["Do not make the first answer slower."],
      confidence: 0.8,
      sourceRefs: ["turn-retrospective"],
    }],
    outsideLearningSurface: [],
  };
}

function seedDeliveredSource(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE btcc_turns (turn_id TEXT PRIMARY KEY, original_message TEXT, context_json TEXT,
        managed_state_json TEXT, opening_answer_json TEXT,
        final_payload_json TEXT, semantic_state TEXT);
      CREATE TABLE btcc_learning_sources (source_id TEXT PRIMARY KEY, turn_id TEXT, source_json TEXT);
      CREATE TABLE btcc_learning_candidate_outbox (outbox_id TEXT PRIMARY KEY, source_id TEXT, status TEXT);
      CREATE TABLE btcc_checkpoints (turn_id TEXT, semantic_state TEXT, turn_revision INTEGER, accepted_product_json TEXT);
      CREATE TABLE btcc_records (record_id TEXT, content_json TEXT);
      CREATE TABLE btcc_context_documents (context_ref TEXT, content TEXT);
    `);
    db.query("INSERT INTO btcc_turns VALUES (?, ?, ?, NULL, NULL, ?, ?)").run(
      "turn-failure", "hello", JSON.stringify({ userRef: "user-1" }), JSON.stringify({ content: "hello" }), "delivered",
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
