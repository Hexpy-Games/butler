import { expect, test } from "bun:test";
import {
  assertTurnStateTransition,
  createTurnKernelController,
  isAllowedTurnStateTransition,
  isTerminalTurnState,
  type TurnState,
  type TerminalTurnState,
} from "../../packages/butler-agent/src/agent/turn/turn-kernel.ts";
import { createKernelTurnOutcomePayload } from "../../packages/butler-agent/src/agent/turn/native/turn-runner/turn-outcome-events.ts";

test("turn kernel admits only declared transitions", () => {
  expect(isAllowedTurnStateTransition("accepted", "model_deciding")).toBe(true);
  expect(isAllowedTurnStateTransition("accepted", "waiting_user")).toBe(true);
  expect(isAllowedTurnStateTransition("accepted", "runtime_fault")).toBe(true);
  expect(isAllowedTurnStateTransition("accepted", "executing_tools")).toBe(false);
  expect(isAllowedTurnStateTransition("model_deciding", "announcing_intent")).toBe(true);
  expect(isAllowedTurnStateTransition("model_deciding", "waiting_user")).toBe(true);
  expect(isAllowedTurnStateTransition("model_deciding", "completed")).toBe(true);
  expect(isAllowedTurnStateTransition("executing_tools", "completed")).toBe(false);
});

test("invalid turn state transitions are rejected deterministically", () => {
  expect(() =>
    assertTurnStateTransition({ from: "model_deciding", to: "accepted" as TurnState }),
  ).toThrow("invalid turn state transition");
  expect(() =>
    assertTurnStateTransition({ from: "completed", to: "waiting_user" as TerminalTurnState }),
  ).toThrow("invalid turn state transition");
});

test("continuing transitions remain non-terminal until explicit terminal transition", () => {
  expect(isAllowedTurnStateTransition("continuing", "completed")).toBe(false);
  expect(isAllowedTurnStateTransition("continuing", "waiting_user")).toBe(true);
  expect(isTerminalTurnState("continuing")).toBe(false);
  expect(isTerminalTurnState("waiting_user")).toBe(true);
});

test("turn kernel rejects direct illegal terminalization", () => {
  const kernel = createTurnKernelController("executing_tools");
  expect(() =>
    kernel.terminalize({
      to: "completed",
      reason: "executor attempted to complete directly",
      evidenceRefs: ["tool:direct"],
    }),
  ).toThrow("invalid turn state transition executing_tools -> completed");
});

test("native turn outcome payloads are created through kernel terminalization", () => {
  const successKernel = createTurnKernelController("observing_tools");
  expect(createKernelTurnOutcomePayload({
    turnKernel: successKernel,
    to: "completed",
    completionEvidenceRefs: [],
    completionEvidenceStatus: "not_required",
    publicSummary: "Completed.",
    reason: "completion_review_complete",
  })).toMatchObject({ outcome: "completed" });
  expect(successKernel.currentState()).toBe("completed");

  const illegalKernel = createTurnKernelController("executing_tools");
  expect(() =>
    createKernelTurnOutcomePayload({
      turnKernel: illegalKernel,
      to: "completed",
      completionEvidenceRefs: [],
      completionEvidenceStatus: "not_required",
      publicSummary: "Completed.",
      reason: "executor attempted to complete directly",
    }),
  ).toThrow("invalid turn state transition executing_tools -> completed");
});
