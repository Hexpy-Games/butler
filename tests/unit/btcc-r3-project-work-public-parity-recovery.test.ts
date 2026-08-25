import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import {
  finalText,
  inspectOfficialWork,
  latestToolPayload,
  PublicParityHarness,
  semanticRowCounts,
  tool,
  toolBatch,
  workIdFrom,
} from "./btcc-r3-project-work-public-parity-harness.ts";

const harnesses: PublicParityHarness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

test("a real native Result replays once, repairs its thin projection, and survives composition restart", async () => {
  const harness = track(new PublicParityHarness("result-recovery"));
  const project = await harness.createProject({
    displayName: "Result recovery",
    ledgerProjectId: "ledger-result-recovery",
  });
  let workId = "";
  let turnId = "";
  let replayedRead: Record<string, any> | undefined;
  const first = await harness.runTurn({
    chatId: project.sessionId,
    text: "Read the public fact and persist its exact Result.",
    beforeDispatch(envelope) {
      turnId = envelope.routingHints?.turnId ?? "";
    },
    steps: [
      tool("result-start", "start_work", { objective: "Recover one exact Result" }),
      (request) => {
        workId = workIdFrom(request, "start_work");
        return tool("result-plan", "replace_work_plan", {
          objective: "Recover one exact Result",
          actions: [{ action_key: "read", dependency_keys: [] }],
          checks: ["The exact Result remains singular"],
        });
      },
      tool("result-read", "read_file", { requests: [{ path: "public-fact.txt" }] }),
      (request) => {
        expect(latestToolPayload(request, "read_file")).toMatchObject({
          ok: true,
        });
        expect(turnId).toMatch(/^turn-/u);
        const db = harness.runtimeDb();
        try {
          db.query("DELETE FROM btcc_guided_work_results WHERE work_id = ?").run(workId);
        } finally {
          db.close();
        }
        return tool("result-read", "read_file", {
          requests: [{ path: "public-fact.txt" }],
        });
      },
      (request) => {
        replayedRead = latestToolPayload(request, "read_file");
        return tool("result-open", "record_work_disposition", {
          work_id: workId,
          disposition: "open",
          summary: "The exact Result replay and projection recovery are verified.",
          remaining_actions: ["Observe restart"],
          next_condition: "The restart Turn arrives.",
        });
      },
      finalText(),
    ],
  });
  expect(first.summary).toMatchObject({ handled: 1, interrupted: 0 });
  expect(replayedRead).toMatchObject({ ok: true });
  const official = await inspectOfficialWork(
    harness.ledgerRoot(project.ledgerProjectId),
    workId,
  );
  expect(official.resultCount).toBe(1);
  const restarted = await harness.runTurn({
    chatId: project.sessionId,
    text: "Observe the recovered Result after production restart.",
    steps: [
      tool("result-restart-continue", "continue_work", { work_id: workId }),
      tool("result-restart-open", "record_work_disposition", {
        work_id: workId,
        disposition: "open",
        summary: "The recovered projection survived restart.",
        remaining_actions: ["Finish later"],
        next_condition: "A later Turn arrives.",
      }),
      finalText(),
    ],
  });
  expect(restarted.summary).toMatchObject({ handled: 1, interrupted: 0 });
  expect((await inspectOfficialWork(
    harness.ledgerRoot(project.ledgerProjectId),
    workId,
  )).resultCount).toBe(1);
  const db = harness.runtimeDb({ readonly: true });
  try {
    expect(semanticRowCounts(db).results).toBe(1);
  } finally {
    db.close();
  }
}, 25_000);

test("a late real native Result reopens completed Project Work and invalidates stale reviews", async () => {
  const harness = track(new PublicParityHarness("late-result"));
  const project = await harness.createProject({
    displayName: "Late Result",
    ledgerProjectId: "ledger-late-result",
  });
  let workId = "";
  const turn = await harness.runTurn({
    chatId: project.sessionId,
    text: "Complete the Work, then observe a late native Result.",
    steps: [
      tool("late-start", "start_work", { objective: "Invalidate stale completion" }),
      (request) => {
        workId = workIdFrom(request, "start_work");
        return tool("late-plan", "replace_work_plan", {
          objective: "Invalidate stale completion",
          actions: [{ action_key: "late", dependency_keys: [] }],
          checks: ["Late evidence reopens Work"],
        });
      },
      tool("late-checkpoint", "record_work_checkpoint", {
        action_updates: [{ action_key: "late", status: "done" }],
        public_summary: "The initial action is done.",
      }),
      tool("late-result-review", "record_work_review", {
        subject: "result",
        verdict: "accept",
        summary: "The initial result window is accepted.",
        corrections: [],
      }),
      toolBatch([
        {
          id: "late-completion-review",
          name: "record_work_review",
          arguments: {
            subject: "completion",
            verdict: "accept",
            summary: "The initial result window satisfies completion.",
            corrections: [],
          },
        },
        {
          id: "late-completed",
          name: "record_work_disposition",
          arguments: {
            work_id: workId,
            disposition: "completed",
            summary: "The initial result window is complete.",
            action_updates: [{ action_key: "late", status: "done" }],
          },
        },
      ]),
      tool("late-read", "read_file", { requests: [{ path: "public-fact.txt" }] }),
      tool("late-open", "record_work_disposition", {
        work_id: workId,
        disposition: "open",
        summary: "Late evidence invalidated the prior completion.",
        remaining_actions: ["Review late evidence"],
        next_condition: "The late evidence is reviewed.",
      }),
      finalText(),
    ],
  });
  expect(turn.summary).toMatchObject({ handled: 1, interrupted: 0 });
  const official = await inspectOfficialWork(
    harness.ledgerRoot(project.ledgerProjectId),
    workId,
  );
  expect(official.semanticStatus).toBe("open");
  expect(official.officialStatus).toBe("in_progress");
  expect(official.resultCount).toBe(1);
  expect(official.manifest.latestResultReviewRevisionId).toBeUndefined();
  expect(official.manifest.latestCompletionValidationRevisionId).toBeUndefined();
}, 25_000);

test("managed Project record corruption fails closed on the next real App ingress", async () => {
  const harness = track(new PublicParityHarness("record-corruption"));
  const project = await harness.createProject({
    displayName: "Record corruption",
    ledgerProjectId: "ledger-record-corruption",
  });
  let workId = "";
  await harness.runTurn({
    chatId: project.sessionId,
    text: "Create managed Work before corruption.",
    steps: [
      tool("corrupt-start", "start_work", { objective: "Reject corruption" }),
      (request) => {
        workId = workIdFrom(request, "start_work");
        return tool("corrupt-plan", "replace_work_plan", {
          objective: "Reject corruption",
          actions: [{ action_key: "guard", dependency_keys: [] }],
          checks: ["Corruption fails closed"],
        });
      },
      finalText(),
      finalText(),
    ],
  });
  const official = await inspectOfficialWork(
    harness.ledgerRoot(project.ledgerProjectId),
    workId,
  );
  const workPath = official.core.projectPath(
    harness.ledgerRoot(project.ledgerProjectId),
    official.workRecord.path,
  );
  const original = readFileSync(workPath, "utf8");
  writeFileSync(
    workPath,
    original.replace(project.appProjectId, "tampered-app-project"),
  );
  official.core.writeIndex(harness.ledgerRoot(project.ledgerProjectId));
  const before = readFileSync(
    `${harness.ledgerRoot(project.ledgerProjectId)}/ledger.jsonl`,
    "utf8",
  );
  const corrupt = await harness.runTurn({
    chatId: project.sessionId,
    text: "Continue the corrupted Work only if authority is exact.",
    steps: [
      tool("corrupt-continue", "continue_work", { work_id: workId }),
      finalText(),
    ],
  });
  const payload = JSON.parse(
    corrupt.model.toolMessages.find((item) => item.name === "continue_work")!.content,
  );
  expect(payload).toMatchObject({
    ok: false,
    error: { code: "work_update_rejected" },
  });
  expect(readFileSync(
    `${harness.ledgerRoot(project.ledgerProjectId)}/ledger.jsonl`,
    "utf8",
  )).toBe(before);
}, 20_000);

test("SQLite Result body tamper is rejected by an exact public Result read", async () => {
  const harness = track(new PublicParityHarness("sqlite-result-tamper", {
    operationResultReplay: true,
  }));
  const project = await harness.createProject({
    displayName: "SQLite Result tamper",
    ledgerProjectId: "ledger-sqlite-result-tamper",
  });
  writeFileSync(`${project.workspacePath}/public-fact.txt`, "X".repeat(16_000));
  let workId = "";
  await harness.runTurn({
    chatId: project.sessionId,
    text: "Create one exact Result before SQLite tamper.",
    steps: [
      tool("sqlite-start", "start_work", { objective: "Reject SQLite tamper" }),
      (request) => {
        workId = workIdFrom(request, "start_work");
        return tool("sqlite-plan", "replace_work_plan", {
          objective: "Reject SQLite tamper",
          actions: [{ action_key: "read", dependency_keys: [] }],
          checks: ["Exact read rejects body tamper"],
        });
      },
      tool("sqlite-read", "read_file", { requests: [{ path: "public-fact.txt" }] }),
      tool("sqlite-open", "record_work_disposition", {
        work_id: workId,
        disposition: "open",
        summary: "The exact Result is ready for integrity verification.",
        remaining_actions: ["Verify exact read"],
        next_condition: "The integrity Turn arrives.",
      }),
      finalText(),
    ],
  });
  const official = await inspectOfficialWork(
    harness.ledgerRoot(project.ledgerProjectId),
    workId,
  );
  const resultBody = official.children.find(({ body }) =>
    body.schema === "butler.btcc-project-work-result-reference.v1",
  )!.body.result as {
    resultRef: string;
    resultSha256: string;
    toolCallId: string;
  };
  const db = harness.runtimeDb();
  try {
    db.query(`
      UPDATE btcc_guided_tool_calls
      SET result_json = ?, result_sha256 = ?
      WHERE call_id = ?
    `).run('{"tampered":true}', "0".repeat(64), resultBody.toolCallId);
  } finally {
    db.close();
  }
  let exactRead: Record<string, any> | undefined;
  const tampered = await harness.runTurn({
    chatId: project.sessionId,
    text: "Read the exact Result only if its stored body is intact.",
    steps: [
      tool("sqlite-continue", "continue_work", { work_id: workId }),
      tool("sqlite-exact", "read_operation_results", {
        result_ref: resultBody.resultRef,
        sha256: resultBody.resultSha256,
        revision: 1,
        work_id: workId,
        offset: 0,
        length: 1,
      }),
      (request) => {
        exactRead = latestToolPayload(request, "read_operation_results");
        return tool("sqlite-still-open", "record_work_disposition", {
          work_id: workId,
          disposition: "open",
          summary: "The corrupt exact read was rejected.",
          remaining_actions: ["Repair stored Result"],
          next_condition: "Stored Result integrity is repaired.",
        });
      },
      finalText(),
    ],
  });
  expect(tampered.summary).toMatchObject({ handled: 1, interrupted: 0 });
  expect(exactRead).toMatchObject({
    ok: false,
    error: { code: "tool_error" },
  });
  const afterTamper = await inspectOfficialWork(
    harness.ledgerRoot(project.ledgerProjectId),
    workId,
  );
  const resultRefs = afterTamper.children.flatMap(({ body }) =>
    body.schema === "butler.btcc-project-work-result-reference.v1"
      ? [body.result?.resultRef]
      : [],
  ).filter((value): value is string => typeof value === "string");
  expect(resultRefs.filter((resultRef) => resultRef === resultBody.resultRef)).toHaveLength(1);
  expect(new Set(resultRefs).size).toBe(resultRefs.length);
}, 25_000);

function track(harness: PublicParityHarness): PublicParityHarness {
  harnesses.push(harness);
  return harness;
}
