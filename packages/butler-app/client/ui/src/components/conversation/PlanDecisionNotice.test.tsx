/// <reference types="bun" />

import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { appCopy } from "@/app/copy.ts";
import { ComposerPlanDecisionSurface } from "./ComposerPlanDecisionSurface";
import { ComposerPlanInstructionContext } from "./ComposerPlanInstructionContext";
import {
  latestActionablePlan,
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

test("only a draft on the newest Butler response is actionable", () => {
  const draft = {
    id: "draft-message",
    role: "assistant" as const,
    text: "Draft",
    plan_document: {
      id: "plan-1",
      title: "Plan",
      status: "draft",
      markdown: "# Draft",
    },
  };

  expect(latestActionablePlan([draft])?.id).toBe("plan-1");
  expect(
    latestActionablePlan([
      draft,
      {
        id: "later-message",
        role: "assistant",
        text: "A later ordinary response",
      },
    ]),
  ).toBeNull();
});

test("Plan decisions replace the Composer input with the exact target", () => {
  const html = renderToStaticMarkup(
    <ComposerPlanDecisionSurface
      decision={{
        editingInstruction: false,
        instructionPlaceholder: "Revise the Plan",
        pending: false,
        planId: "plan-1",
        planTitle: "Snake game implementation",
        onAccept: () => undefined,
        onOpenInstruction: () => undefined,
        onOpenPlan: () => undefined,
        onReject: () => undefined,
        onSubmitInstruction: () => undefined,
      }}
    />,
  );

  expect(html).toContain('data-test-class="composer-plan-decision"');
  expect(html).toContain("Snake game implementation");
  expect(html).toContain(appCopy.composer.planAccept);
  expect(html).toContain(appCopy.composer.planReject);
  expect(html).toContain(appCopy.composer.planInstruction);
  expect(html).not.toContain("<input");
  expect(html).not.toContain("<textarea");
});

test("direct Plan feedback keeps a non-removable Plan document context", () => {
  const html = renderToStaticMarkup(
    <ComposerPlanInstructionContext
      decision={{
        editingInstruction: true,
        instructionPlaceholder: "Revise the Plan",
        pending: false,
        planId: "plan-1",
        planTitle: "Snake game implementation",
        onAccept: () => undefined,
        onOpenInstruction: () => undefined,
        onOpenPlan: () => undefined,
        onReject: () => undefined,
        onSubmitInstruction: () => undefined,
      }}
    />,
  );

  expect(html).toContain("Snake game implementation");
  expect(html).toContain(appCopy.composer.planInstructionActive);
  expect(html).not.toContain("Remove");
});
