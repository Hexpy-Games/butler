import { expect, test } from "bun:test";
import { createGuidedTurnCloseout } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-closeout.ts";
import { runBtccAgentLoop } from "../../packages/butler-agent/src/agent/btcc/agent-loop/index.ts";
import {
  dispositionMaterialFingerprint,
  type DurableWorkService,
  type DurableWorkView,
} from "../../packages/butler-agent/src/agent/btcc/work/index.ts";
import type { GuidedToolJournalRecord } from "../../packages/butler-agent/src/agent/btcc/ports/index.ts";
import type { ModelRoundRequest } from "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";

const scope = { turnId: "child-turn", sessionId: "child" };

function work(status: DurableWorkView["status"], fresh?: { disposition: "open" | "blocked"; runtimeOwnedOpen?: boolean }): DurableWorkView {
  const view = {
    workId: "work-1", sessionId: "child", status, currentStage: "execution",
    actionProgress: [{ actionKey: "build", status: "active" }, { actionKey: "test", status: "pending" }], resultRefs: [],
  } as unknown as DurableWorkView;
  if (!fresh) return view;
  return { ...view, latestDisposition: {
    disposition: fresh.disposition, originTurnId: scope.turnId, runtimeOwnedOpen: fresh.runtimeOwnedOpen ?? false,
    summary: "Waiting on a decision", remainingActions: [], nextCondition: "Which database should be used?",
    materialFingerprint: dispositionMaterialFingerprint(view),
  } } as unknown as DurableWorkView;
}

function service(bound: DurableWorkView | null, context: DurableWorkView | null = null): DurableWorkService {
  const claimed = new Set<string>();
  return {
    boundWorkForTurn: async () => bound,
    loadContext: async () => context ? { work: context } : null,
    claimCloseoutCorrection: async ({ workId }: { workId: string }) => {
      if (claimed.has(workId)) return false;
      claimed.add(workId);
      return true;
    },
  } as unknown as DurableWorkService;
}

function childCloseout(durableWork: DurableWorkService, records: GuidedToolJournalRecord[] = []) {
  return createGuidedTurnCloseout({
    durableWork, workScope: scope, turnId: scope.turnId, trackingMode: "local",
    responseLanguage: "English", originalRequest: "Implement", requiresTerminalResult: true,
    toolJournal: { list: () => records },
  });
}

test("a child text-only final gets one actionable correction, then settles incomplete for the parent", async () => {
  const closeout = childCloseout(service(work("open")));
  const first = await closeout.reviewFinalCandidate({ text: "I think it is done." });
  expect(first.status).toBe("continue");
  const observation = first.status === "continue" ? first.observation : "";
  expect(observation).toContain("Work work-1 is open");
  expect(observation).toContain("build, test");
  expect(observation).toContain("completed");
  expect(observation).toContain("needs_user_decision");
  const second = await closeout.reviewFinalCandidate({ text: "I think it is done." });
  expect(second).toEqual({ status: "accepted", text: "I think it is done." });
  expect(await closeout.acceptedWorkResult()).toEqual({
    status: "incomplete", code: "child_closeout_missing",
    evidence: ["Work work-1 status: open", "Unresolved actions: build, test"],
  });
  expect(await closeout.reconcileAfterLoop("I think it is done.")).toBe("I think it is done.");
});

test("an unbound child is told to bind the assigned Work by id", async () => {
  const closeout = childCloseout(service(null, work("open")));
  const first = await closeout.reviewFinalCandidate({ text: "" });
  expect(first.status === "continue" ? first.observation : "").toContain("continue_work (work_id: work-1)");
  const second = await closeout.reviewFinalCandidate({ text: "" });
  expect(second.status).toBe("accepted");
  expect(second.status === "accepted" ? second.text : "").toContain("No final report was written.");
  expect((await closeout.acceptedWorkResult())?.status).toBe("incomplete");
});

test("abandoned Work is reported immediately as blocked work_abandoned", async () => {
  const closeout = childCloseout(service(work("abandoned")));
  expect((await closeout.reviewFinalCandidate({ text: "" })).status).toBe("accepted");
  expect(await closeout.acceptedWorkResult()).toMatchObject({ status: "blocked", code: "work_abandoned" });
});

test("a blocked disposition relays needs_user_decision with its evidence", async () => {
  const records = [{ callId: "c", toolName: "record_work_disposition", rawArguments: "{}", status: "completed",
    arguments: { disposition: "blocked", blocked_code: "needs_user_decision" } }] as GuidedToolJournalRecord[];
  const closeout = childCloseout(service(work("blocked", { disposition: "blocked" })), records);
  expect((await closeout.reviewFinalCandidate({ text: "Need a decision." })).status).toBe("accepted");
  const result = await closeout.acceptedWorkResult();
  expect(result).toMatchObject({ status: "blocked", code: "needs_user_decision" });
  expect(result?.evidence).toContain("Next condition: Which database should be used?");
});

test("the Butler runtime-owned open notice reads as a progress note, not an error", async () => {
  const closeout = createGuidedTurnCloseout({
    durableWork: service(work("open", { disposition: "open", runtimeOwnedOpen: true })), workScope: scope,
    turnId: scope.turnId, trackingMode: "local", responseLanguage: "English", originalRequest: "Implement",
  });
  const review = await closeout.reviewFinalCandidate({ text: "Here is where things stand." });
  const text = review.status === "accepted" ? review.text ?? "" : "";
  expect(text).toStartWith("Progress note: this work is still open and can be continued.");
  expect(text).not.toMatch(/could not|failed|error/iu);
});

test("the agent loop delivers the correction once and never raises a runtime failure", async () => {
  const requests: ModelRoundRequest[] = [];
  const closeout = childCloseout(service(work("open")));
  const output = await runBtccAgentLoop({
    prompt: "Implement the assigned action.", tools: [],
    modelRound: { async runRound(request) {
      requests.push(structuredClone(request));
      if (requests.length > 2) throw new Error("scripted model exceeded 2 rounds");
      return { text: "Finished, I believe.", toolCalls: [] };
    } },
    executeTool: async () => ({}),
    reviewFinalCandidate: closeout.reviewFinalCandidate,
  });
  expect(output.finalText).toBe("Finished, I believe.");
  const corrections = requests[1]!.messages.filter((message) => message.role === "user" &&
    message.content.includes("has no terminal disposition"));
  expect(corrections).toHaveLength(1);
  expect((await closeout.acceptedWorkResult())?.status).toBe("incomplete");
});
