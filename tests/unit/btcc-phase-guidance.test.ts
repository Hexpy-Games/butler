import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBtccSqliteStores } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { phaseGuidanceRevisionRef } from "../../packages/butler-agent/src/agent/btcc/guidance/index.ts";

test("phase guidance is versioned, idempotent, scoped, ordered, and restart-safe", () => {
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

    expect(stores.phaseGuidance.list({
      phase: "planning",
      userRef: "user-1",
      projectRef: "project-1",
    })).toEqual([projectOverride, projectGuidance]);
    expect(stores.phaseGuidance.list({
      phase: "planning",
      userRef: "user-1",
      projectRef: "project-2",
    })).toEqual([superseded]);
    expect(stores.phaseGuidance.list({
      phase: "reporting",
      userRef: "user-1",
      projectRef: "project-1",
    })).toEqual([]);
  } finally {
    stores.close();
  }

  const reopened = openBtccSqliteStores({ dbPath, ownerId: "owner-2" });
  try {
    expect(reopened.phaseGuidance.list({
      phase: "planning",
      userRef: "user-1",
      projectRef: "project-1",
    }).map((entry) => [entry.guidanceId, entry.revision])).toEqual([
      ["preserve-original-goal", 1],
      ["project-spec-first", 1],
    ]);
  } finally {
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});
