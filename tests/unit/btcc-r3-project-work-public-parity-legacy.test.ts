import { afterEach, expect, test } from "bun:test";
import {
  finalText,
  inspectOfficialWork,
  PublicParityHarness,
  semanticRowCounts,
  tool,
  workIdFrom,
} from "./btcc-r3-project-work-public-parity-harness.ts";

const harnesses: PublicParityHarness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

test("a real Session B1 source imports into Project authority once, then public re-entry is a fixed point", async () => {
  const harness = track(new PublicParityHarness("legacy-fixed-point"));
  const project = await harness.createProject({
    displayName: "Legacy fixed point",
    ledgerProjectId: "ledger-legacy-fixed-point",
  });
  harness.setSessionProject(project.sessionId, null);
  let workId = "";
  const legacy = await harness.runTurn({
    chatId: project.sessionId,
    text: "Create the real pre-cutover Session authority.",
    beforeDispatch(envelope) {
      expect(envelope.appTurnContext?.project).toBeUndefined();
    },
    steps: [
      tool("legacy-start", "start_work", { objective: "Import this real Session Work" }),
      (request) => {
        workId = workIdFrom(request, "start_work");
        return tool("legacy-plan", "replace_work_plan", {
          objective: "Import this real Session Work",
          actions: [{ action_key: "publish", dependency_keys: [] }],
          checks: ["One canonical Project authority remains"],
        });
      },
      tool("legacy-read", "read_file", { requests: [{ path: "public-fact.txt" }] }),
      tool("legacy-checkpoint", "record_work_checkpoint", {
        action_updates: [{ action_key: "publish", status: "active" }],
        public_summary: "The real legacy source is stable.",
        next_step: "Import through Project ingress.",
      }),
      tool("legacy-open", "record_work_disposition", {
        work_id: workId,
        disposition: "open",
        summary: "The real Session source awaits Project import.",
        remaining_actions: ["Import canonical Project records"],
        next_condition: "The Project Turn arrives.",
      }),
      finalText(),
    ],
  });
  expect(legacy.summary).toMatchObject({ handled: 1, interrupted: 0 });

  const db = harness.runtimeDb();
  try {
    expect(semanticRowCounts(db)).toMatchObject({ works: 1, plans: 1, results: 1 });
    db.query(`
      UPDATE btcc_guided_works
      SET scope_kind = 'project', scope_ref = ?, ledger_project_id = ?
      WHERE work_id = ?
    `).run(project.appProjectId, project.ledgerProjectId, workId);
  } finally {
    db.close();
  }
  harness.setSessionProject(project.sessionId, project.appProjectId);

  const imported = await harness.runTurn({
    chatId: project.sessionId,
    text: "Import the stable legacy authority through production composition.",
    steps: [finalText(), finalText()],
  });
  expect(imported.summary).toMatchObject({ handled: 1, interrupted: 0 });
  const first = await inspectOfficialWork(
    harness.ledgerRoot(project.ledgerProjectId),
    workId,
  );
  expect(first).toMatchObject({
    legacyImportCount: 1,
    planCount: 1,
    resultCount: 1,
  });
  const firstSemanticCounts = {
    works: first.index.records.filter((record) => record.kind === "work").length,
    plans: first.planCount,
    results: first.resultCount,
    imports: first.legacyImportCount,
  };
  const projected = harness.runtimeDb({ readonly: true });
  try {
    expect(semanticRowCounts(projected)).toMatchObject({
      works: 1,
      plans: 0,
      checkpoints: 0,
      reviews: 0,
      dispositions: 0,
      legacyImports: 1,
    });
  } finally {
    projected.close();
  }

  const replay = await harness.runTurn({
    chatId: project.sessionId,
    text: "Re-enter the exact legacy fixed point without a second import.",
    steps: [finalText(), finalText()],
  });
  expect(replay.summary).toMatchObject({ handled: 1, interrupted: 0 });
  const second = await inspectOfficialWork(
    harness.ledgerRoot(project.ledgerProjectId),
    workId,
  );
  expect({
    works: second.index.records.filter((record) => record.kind === "work").length,
    plans: second.planCount,
    results: second.resultCount,
    imports: second.legacyImportCount,
  }).toEqual(firstSemanticCounts);
}, 25_000);

function track(harness: PublicParityHarness): PublicParityHarness {
  harnesses.push(harness);
  return harness;
}
