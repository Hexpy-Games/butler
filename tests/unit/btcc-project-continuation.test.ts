import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { discoverDeferredContinuationCandidates } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/continuation-candidate-discovery.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";

test("Project continuation comes from the canonical Project Work Ledger manifest", async () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  db.query(`
    INSERT INTO btcc_project_program_projections
      (program_id, project_ref, ledger_id, manifest_revision)
    VALUES ('program-project', 'project-fixture', 'project:fixture', 7)
  `).run();
  db.query(`
    INSERT INTO btcc_turns (
      turn_id, session_id, inbox_id, trigger_key, original_message_id,
      original_message, admission_snapshot_ref, model_selection_json,
      context_json, continuation_snapshot_json, semantic_state,
      revision, execution_fence, final_disposition
    ) VALUES (
      'source-turn', 'session', 'source-inbox', 'source-trigger', 'source-message',
      'blocked', 'snapshot', '{}', '{}', '[]', 'delivered', 9, 1, 'deferred'
    )
  `).run();
  const goalContractRef = { id: "goal", sha256: "a".repeat(64) };
  const anchorRef = { id: "anchor", sha256: "b".repeat(64) };
  const blockerRef = { id: "blocker", sha256: "c".repeat(64) };
  const candidates = await discoverDeferredContinuationCandidates(
    db,
    command(),
    {
      resolveProjectRoot: () => "/canonical/project",
      publications: {
        async listDeferredPrograms(root: string) {
          expect(root).toBe("/canonical/project");
          return [{
            ledgerId: "project:fixture",
            programId: "program-project",
            manifestRevision: 7,
            goalContractRef,
            activeDeferral: {
              blocker: { ref: blockerRef },
              anchor: { ref: anchorRef, sourceTurnId: "source-turn" },
            },
          }] as never;
        },
      } as never,
    },
  );
  expect(candidates).toEqual([{
    candidateId: expect.any(String),
    ledgerId: "project:fixture",
    programId: "program-project",
    expectedManifestRevision: 7,
    baseManifestHash: expect.any(String),
    sourceTurnId: "source-turn",
    originalGoalContractRef: goalContractRef,
    anchorRef,
    blockerRef,
  }]);
  db.close();
});

function command() {
  return {
    kind: "run" as const,
    turnId: "continuation-turn",
    sessionId: "session",
    triggerKey: "trigger",
    message: { messageId: "message", content: "Continue" },
    modelSelection: {
      provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "low" as const,
      controls: { reasoningEffort: "low" }, controlsHash: "controls",
    },
    context: {
      userRef: "user", projectRef: "project-fixture", profileRefs: [],
      recentFeedbackRefs: [], mandatoryHotCacheRefs: [], optionalHotCacheRefs: [],
      baselineObservationScopeRefs: ["workspace:/project"],
    },
  };
}
