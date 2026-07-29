import { expect, test } from "bun:test";
import { BtccTurnProgressHub } from
  "../../packages/butler-agent/src/agent/composition/production-btcc/progress-hub.ts";

test("relays phase activity only to observers of the matching turn", async () => {
  const hub = new BtccTurnProgressHub();
  const observed: unknown[] = [];
  hub.observe("turn-observed", {
    async stateChanged() {},
    phaseActivityChanged(update) {
      observed.push(update);
    },
  });
  hub.observe("turn-other", {
    async stateChanged() {},
    phaseActivityChanged() {
      throw new Error("unrelated turn observer must not receive activity");
    },
  });

  await hub.phaseActivityChanged({
    turnId: "turn-observed",
    semanticState: "planning",
    activityId: "phase-activity:planning-round",
    title: "수정 범위 확인",
    summary: "수정 범위를 확인하고 있습니다.",
    rationale: "완결된 계획을 세우기 위해 필요합니다.",
    nextStep: "계획 후보를 작성합니다.",
  });

  expect(observed).toEqual([{
    turnId: "turn-observed",
    semanticState: "planning",
    activityId: "phase-activity:planning-round",
    title: "수정 범위 확인",
    summary: "수정 범위를 확인하고 있습니다.",
    rationale: "완결된 계획을 세우기 위해 필요합니다.",
    nextStep: "계획 후보를 작성합니다.",
  }]);
});

test("relays model-round liveness only to observers of the matching turn", async () => {
  const hub = new BtccTurnProgressHub();
  const observed: unknown[] = [];
  hub.observe("turn-observed", {
    async stateChanged() {},
    modelRoundWaiting(update) {
      observed.push(update);
    },
  });
  hub.observe("turn-other", {
    async stateChanged() {},
    modelRoundWaiting() {
      throw new Error("unrelated turn observer must not receive liveness");
    },
  });

  await hub.modelRoundWaiting({
    turnId: "turn-observed",
    semanticState: "planning",
    checkpointId: "checkpoint-planning",
  });

  expect(observed).toEqual([{
    turnId: "turn-observed",
    semanticState: "planning",
    checkpointId: "checkpoint-planning",
  }]);
});
