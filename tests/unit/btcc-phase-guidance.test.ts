import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBtccSqliteStores } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { phaseGuidanceRevisionRef } from "../../packages/butler-agent/src/agent/btcc/guidance/index.ts";
import {
  createProductionSelectedModel,
  type ProviderPhasePrompt,
} from "../../packages/butler-agent/src/agent/btcc/infrastructure/model/index.ts";
import {
  actualIdentity,
  emptyCapabilityCatalog,
  emptyContextResolver,
  parseCacheOrderedPrompt,
  phaseEnvelope,
  promptRunner,
  publicActivity,
} from "./support/btcc-production-selected-model-fixtures.ts";

test("phase guidance is versioned, idempotent, scoped, rendered, and restart-safe", async () => {
  const root = join(tmpdir(), `btcc-phase-guidance-${Date.now()}`);
  const dbPath = join(root, "btcc.sqlite");
  const stores = openBtccSqliteStores({ dbPath, ownerId: "owner-1" });
  const userScopeEvidence = {
    scopeRationale: "The preference applies across the user's projects.",
    scopeSourceRefs: ["source-user"],
    generalityBoundary: "cross_project_user_preference" as const,
  };
  const projectScopeEvidence = {
    scopeRationale: "The strategy is specific to project-1.",
    scopeSourceRefs: ["source-project"],
    generalityBoundary: "project_bound_strategy" as const,
  };
  const sessionScopeEvidence = {
    scopeRationale: "The strategy is specific to session-1.",
    scopeSourceRefs: ["source-session"],
    generalityBoundary: "session_bound_strategy" as const,
  };
  const globalScopeEvidence = {
    scopeRationale: "The practice is stable across users, projects, and sessions.",
    scopeSourceRefs: ["source-global"],
    generalityBoundary: "global_phase_practice" as const,
  };

  try {
    const userGuidance = stores.phaseGuidance.publish({
      disposition: "promote",
      guidance: {
        guidanceId: "preserve-original-goal",
        phase: "planning",
        scope: { kind: "user", userRef: "user-1" },
        ...userScopeEvidence,
        guidance: "Trace planned outcomes to the immutable original goal.",
        appliesWhen: ["the turn requires managed work"],
        doesNotApplyWhen: ["the request is a direct answer"],
        sourceIds: ["source-user"],
      },
    });
    const repeated = stores.phaseGuidance.publish({
      disposition: "promote",
      guidance: {
        guidanceId: "preserve-original-goal",
        phase: "planning",
        scope: { kind: "user", userRef: "user-1" },
        ...userScopeEvidence,
        guidance: "Trace planned outcomes to the immutable original goal.",
        appliesWhen: ["the turn requires managed work"],
        doesNotApplyWhen: ["the request is a direct answer"],
        sourceIds: ["source-user"],
      },
    });
    expect(repeated).toEqual(userGuidance);
    expect(() => stores.phaseGuidance.publish({
      disposition: "promote",
      guidance: {
        guidanceId: "preserve-original-goal",
        phase: "planning",
        scope: { kind: "user", userRef: "user-1" },
        ...userScopeEvidence,
        guidance: "Promote cannot rewrite an existing stable guidance ID.",
        appliesWhen: [],
        doesNotApplyWhen: [],
        sourceIds: ["source-other"],
      },
    })).toThrow("phase_guidance_promote_requires_new_stable_id");

    const revised = stores.phaseGuidance.publish({
      disposition: "merge",
      target: phaseGuidanceRevisionRef(userGuidance),
      guidance: {
        guidanceId: "preserve-original-goal",
        phase: "planning",
        scope: { kind: "user", userRef: "user-1" },
        ...userScopeEvidence,
        scopeSourceRefs: ["source-revision"],
        guidance: "Trace every Work and Task outcome to the immutable original goal.",
        appliesWhen: ["reviewed managed work"],
        doesNotApplyWhen: ["reviewed direct answer"],
        sourceIds: ["source-revision"],
      },
    });
    expect(revised.revision).toBe(2);
    expect(revised).toMatchObject({
      revisionKind: "merge",
      predecessor: phaseGuidanceRevisionRef(userGuidance),
      sourceIds: ["source-user", "source-revision"],
      scopeSourceRefs: ["source-user", "source-revision"],
      appliesWhen: ["reviewed managed work"],
      doesNotApplyWhen: ["reviewed direct answer"],
    });
    const replayedRevision = stores.phaseGuidance.publish({
      disposition: "merge",
      target: phaseGuidanceRevisionRef(userGuidance),
      guidance: {
        guidanceId: "preserve-original-goal",
        phase: "planning",
        scope: { kind: "user", userRef: "user-1" },
        ...userScopeEvidence,
        scopeSourceRefs: ["source-revision"],
        guidance: "Trace every Work and Task outcome to the immutable original goal.",
        appliesWhen: ["reviewed managed work"],
        doesNotApplyWhen: ["reviewed direct answer"],
        sourceIds: ["source-revision"],
      },
    });
    expect(replayedRevision).toEqual(revised);
    expect(() => stores.phaseGuidance.publish({
      disposition: "supersede",
      target: phaseGuidanceRevisionRef(userGuidance),
      guidance: {
        guidanceId: "preserve-original-goal",
        phase: "planning",
        scope: { kind: "user", userRef: "user-1" },
        ...userScopeEvidence,
        scopeSourceRefs: ["source-stale"],
        guidance: "A stale revision must not be replaced.",
        appliesWhen: ["managed work"],
        doesNotApplyWhen: [],
        sourceIds: ["source-stale"],
      },
    })).toThrow("phase_guidance_target_revision_not_active");
    const superseded = stores.phaseGuidance.publish({
      disposition: "supersede",
      target: phaseGuidanceRevisionRef(revised),
      guidance: {
        guidanceId: "preserve-original-goal",
        phase: "planning",
        scope: { kind: "user", userRef: "user-1" },
        ...userScopeEvidence,
        scopeSourceRefs: ["source-final"],
        guidance: "Keep every planned outcome anchored to the immutable original goal.",
        appliesWhen: ["the reviewed plan creates work"],
        doesNotApplyWhen: ["no work obligation exists"],
        sourceIds: ["source-final"],
      },
    });
    expect(superseded).toMatchObject({
      revision: 3,
      revisionKind: "supersede",
      predecessor: phaseGuidanceRevisionRef(revised),
      sourceIds: ["source-user", "source-revision", "source-final"],
      scopeSourceRefs: ["source-user", "source-revision", "source-final"],
      appliesWhen: ["the reviewed plan creates work"],
      doesNotApplyWhen: ["no work obligation exists"],
    });

    const projectGuidance = stores.phaseGuidance.publish({
      disposition: "promote",
      guidance: {
        guidanceId: "project-spec-first",
        phase: "planning",
        scope: { kind: "project", projectRef: "project-1" },
        ...projectScopeEvidence,
        guidance: "Read the governing Project Ledger Spec before authoring Tasks.",
        appliesWhen: ["a project binding exists"],
        doesNotApplyWhen: [],
        sourceIds: ["source-project"],
      },
    });
    const projectOverride = stores.phaseGuidance.publish({
      disposition: "promote",
      guidance: {
        guidanceId: "preserve-original-goal",
        phase: "planning",
        scope: { kind: "project", projectRef: "project-1" },
        ...projectScopeEvidence,
        guidance: "Trace this project's Work and Task outcomes to its governing Spec.",
        appliesWhen: ["project-1 is active"],
        doesNotApplyWhen: [],
        sourceIds: ["source-project"],
      },
    });
    const sessionGuidance = stores.phaseGuidance.publish({
      disposition: "promote",
      guidance: {
        guidanceId: "session-check-frontier",
        phase: "planning",
        scope: { kind: "session", sessionId: "session-1" },
        ...sessionScopeEvidence,
        guidance: "Preserve this session's accepted frontier while planning the next step.",
        appliesWhen: ["session-1 continues"],
        doesNotApplyWhen: [],
        sourceIds: ["source-session"],
      },
    });
    const globalGuidance = stores.phaseGuidance.publish({
      disposition: "promote",
      guidance: {
        guidanceId: "global-state-input",
        phase: "planning",
        scope: { kind: "global" },
        ...globalScopeEvidence,
        guidance: "Treat accepted state as input and never select a successor phase.",
        appliesWhen: ["planning runs"],
        doesNotApplyWhen: [],
        sourceIds: ["source-global"],
      },
    });

    expect(stores.phaseGuidance.list({
      phase: "planning",
      userRef: "user-1",
      sessionId: "session-1",
      projectRef: "project-1",
    })).toEqual([sessionGuidance, projectOverride, projectGuidance, globalGuidance]);
    expect(stores.phaseGuidance.list({
      phase: "planning",
      userRef: "user-1",
      sessionId: "session-2",
      projectRef: "project-2",
    })).toEqual([superseded, globalGuidance]);
    expect(stores.phaseGuidance.list({
      phase: "reporting",
      userRef: "user-1",
      sessionId: "session-1",
      projectRef: "project-1",
    })).toEqual([]);

    const calls: ProviderPhasePrompt[] = [];
    const model = createProductionSelectedModel({
      context: emptyContextResolver(),
      capabilities: emptyCapabilityCatalog(),
      guidance: stores.phaseGuidance,
      promptRunner: promptRunner(async (input) => {
        calls.push(input);
        return {
          carrier: { kind: "phase_submission", submission: { kind: "plan" }, publicActivity },
          actualIdentity: actualIdentity(),
        };
      }),
    });
    await model.runRound(phaseEnvelope({ emptyContext: true }));
    const { stable } = parseCacheOrderedPrompt(calls[0]!.prompt);
    const guidanceLayer = stable.promptHierarchy.find(
      (layer: { layer: string }) => layer.layer === "acceptedPhaseGuidance",
    );
    expect(guidanceLayer.content.map(
      (entry: { scope: { kind: string } }) => entry.scope.kind,
    )).toEqual(["global", "project", "project", "session"]);
  } finally {
    stores.close();
  }

  const reopened = openBtccSqliteStores({ dbPath, ownerId: "owner-2" });
  try {
    expect(reopened.phaseGuidance.list({
      phase: "planning",
      userRef: "user-1",
      sessionId: "session-1",
      projectRef: "project-1",
    }).map((entry) => [entry.guidanceId, entry.revision])).toEqual([
      ["session-check-frontier", 1],
      ["preserve-original-goal", 1],
      ["project-spec-first", 1],
      ["global-state-input", 1],
    ]);
  } finally {
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});
