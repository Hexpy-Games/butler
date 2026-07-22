import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBtccSqliteStores } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";

test("phase guidance is versioned, idempotent, scoped, ordered, and restart-safe", () => {
  const root = join(tmpdir(), `btcc-phase-guidance-${Date.now()}`);
  const dbPath = join(root, "btcc.sqlite");
  const stores = openBtccSqliteStores({ dbPath, ownerId: "owner-1" });

  try {
    const userGuidance = stores.phaseGuidance.publish({
      guidanceId: "preserve-original-goal",
      phase: "planning",
      scope: { kind: "user", userRef: "user-1" },
      guidance: "Trace planned outcomes to the immutable original goal.",
      appliesWhen: ["the turn requires managed work"],
      doesNotApplyWhen: ["the request is a direct answer"],
      sourceIds: ["source-user"],
    });
    const repeated = stores.phaseGuidance.publish({
      guidanceId: "preserve-original-goal",
      phase: "planning",
      scope: { kind: "user", userRef: "user-1" },
      guidance: "Trace planned outcomes to the immutable original goal.",
      appliesWhen: ["the turn requires managed work"],
      doesNotApplyWhen: ["the request is a direct answer"],
      sourceIds: ["source-user"],
    });
    expect(repeated).toEqual(userGuidance);

    const revised = stores.phaseGuidance.publish({
      guidanceId: "preserve-original-goal",
      phase: "planning",
      scope: { kind: "user", userRef: "user-1" },
      guidance: "Trace every Work and Task outcome to the immutable original goal.",
      appliesWhen: ["the turn requires managed work"],
      doesNotApplyWhen: ["the request is a direct answer"],
      sourceIds: ["source-user", "source-revision"],
    });
    expect(revised.revision).toBe(2);

    const projectGuidance = stores.phaseGuidance.publish({
      guidanceId: "project-spec-first",
      phase: "planning",
      scope: { kind: "project", projectRef: "project-1" },
      guidance: "Read the governing Project Ledger Spec before authoring Tasks.",
      appliesWhen: ["a project binding exists"],
      doesNotApplyWhen: [],
      sourceIds: ["source-project"],
    });

    expect(stores.phaseGuidance.list({
      phase: "planning",
      userRef: "user-1",
      projectRef: "project-1",
    })).toEqual([projectGuidance, revised]);
    expect(stores.phaseGuidance.list({
      phase: "planning",
      userRef: "user-1",
      projectRef: "project-2",
    })).toEqual([revised]);
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
      ["project-spec-first", 1],
      ["preserve-original-goal", 2],
    ]);
  } finally {
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});
