import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  finalText,
  latestToolPayload,
  PublicParityHarness,
  semanticRowCounts,
  tool,
  workIdFrom,
} from "./btcc-r3-project-work-public-parity-harness.ts";

const harnesses: PublicParityHarness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

test("the real general Session adapter survives production-composition restart without a fake Project", async () => {
  const harness = track(new PublicParityHarness("session-restart"));
  let workId = "";
  const started = await harness.runTurn({
    chatId: "general",
    text: "Start durable Session Work without a Project.",
    beforeDispatch(envelope) {
      expect(envelope.appTurnContext?.session).toMatchObject({
        id: "general",
        kind: "chat",
      });
      expect(envelope.appTurnContext?.project).toBeUndefined();
    },
    steps: [
      tool("session-start", "start_work", { objective: "Session restart parity" }),
      (request) => {
        workId = workIdFrom(request, "start_work");
        return tool("session-plan", "replace_work_plan", {
          objective: "Session restart parity",
          actions: [{ action_key: "resume", dependency_keys: [] }],
          checks: ["The Session Work resumes after composition restart"],
        });
      },
      finalText(),
      finalText(),
    ],
  });
  expect(started.summary).toMatchObject({ handled: 1, interrupted: 0 });

  const resumed = await harness.runTurn({
    chatId: "general",
    text: "Resume the exact Session Work after restart.",
    steps: [
      tool("session-continue", "continue_work", { work_id: workId }),
      tool("session-open", "record_work_disposition", {
        work_id: workId,
        disposition: "open",
        summary: "The restarted Session path retained its Work.",
        remaining_actions: ["Finish later"],
        next_condition: "A later Session Turn arrives.",
      }),
      finalText(),
    ],
  });
  expect(resumed.summary).toMatchObject({ handled: 1, interrupted: 0 });
  expect(latestToolPayload(resumed.model.requests.at(-2)!, "continue_work"))
    .toMatchObject({ output: { work: { work_id: workId } } });
  const db = harness.runtimeDb({ readonly: true });
  try {
    expect(semanticRowCounts(db)).toMatchObject({
      works: 1,
      plans: 1,
      dispositions: 2,
    });
  } finally {
    db.close();
  }
  expect(existsSync(join(harness.root, "project-ledger", "projects"))).toBe(false);
}, 20_000);

test("a real simple App chat creates no durable Work", async () => {
  const harness = track(new PublicParityHarness("simple-chat"));
  const chat = await harness.runTurn({
    chatId: "general",
    text: "Say hello without creating Work.",
    steps: [finalText("Hello from the simple public chat path.")],
  });
  expect(chat.summary).toMatchObject({ handled: 1, interrupted: 0 });
  const db = harness.runtimeDb({ readonly: true });
  try {
    expect(semanticRowCounts(db).works).toBe(0);
  } finally {
    db.close();
  }
  expect(existsSync(join(harness.root, "project-ledger"))).toBe(false);
}, 15_000);

function track(harness: PublicParityHarness): PublicParityHarness {
  harnesses.push(harness);
  return harness;
}
