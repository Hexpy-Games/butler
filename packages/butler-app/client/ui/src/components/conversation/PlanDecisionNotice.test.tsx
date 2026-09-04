/// <reference types="bun" />

import { expect, test } from "bun:test";
import {
  latestPendingPlan,
  submitProjectedPlanDecision,
} from "./useComposerPlanDecision";

test("direct instructions use the instruct action and returned Plan mode", async () => {
  const calls: unknown[] = [];
  const projectedModes: boolean[] = [];
  const applied = await submitProjectedPlanDecision({
    action: "instruct",
    activeChatId: "session-plan",
    applyPlanMode: (enabled) => projectedModes.push(enabled),
    instruction: "  Keep the drawer flat  ",
    planId: "plan-1",
    submit: async (sessionId, planId, action, instruction) => {
      calls.push({ sessionId, planId, action, instruction });
      return {
        plan_document: {
          id: "plan-1",
          kind: "plan",
          title: "Composer Plan",
          status: "draft",
          markdown: "# Revised Plan",
          safe_path_label: "Plan",
          updated_at: "2026-09-04T00:00:00.000Z",
        },
        controls: {
          session_id: "session-plan",
          controls: {
            model: "openai/gpt-5.5",
            reasoning_effort: "medium",
            access_mode: "full_access",
            plan_mode: true,
          },
          revision: 3,
          catalog_generation: "test",
        },
      };
    },
  });

  expect(applied).toBe(true);
  expect(calls).toEqual([
    {
      sessionId: "session-plan",
      planId: "plan-1",
      action: "instruct",
      instruction: "Keep the drawer flat",
    },
  ]);
  expect(projectedModes).toEqual([true]);
});

test("an active newest Plan suppresses an older draft decision form", () => {
  expect(
    latestPendingPlan([
      {
        id: "draft-message",
        role: "assistant",
        text: "Draft",
        plan_document: {
          id: "plan-1",
          title: "Plan",
          status: "draft",
          markdown: "# Draft",
        },
      },
      {
        id: "active-message",
        role: "assistant",
        text: "Accepted",
        plan_document: {
          id: "plan-1",
          title: "Plan",
          status: "active",
          markdown: "# Active",
        },
      },
    ]),
  ).toBeNull();
});
