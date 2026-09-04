/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { useButlerStore } from "./store.ts";
import type { PlanDecisionResultView } from "./types.ts";

const initialState = useButlerStore.getState();

afterEach(() => {
  useButlerStore.setState(initialState);
  delete (globalThis as { window?: unknown }).window;
});

test("submits the typed Plan decision bridge request and projects returned state", async () => {
  const requests: unknown[] = [];
  const response: PlanDecisionResultView = {
    plan_document: {
      id: "plan-1",
      kind: "plan",
      title: "Composer Plan",
      status: "active",
      markdown: "# Active Plan",
      safe_path_label: "Plan",
      updated_at: "2026-09-04T00:00:00.000Z",
    },
    controls: {
      session_id: "session-1",
      controls: {
        model: "openai/gpt-5.5",
        reasoning_effort: "medium",
        access_mode: "full_access",
        plan_mode: false,
      },
      revision: 3,
      catalog_generation: "test",
    },
  };
  Object.assign(globalThis, {
    window: {
      location: { origin: "http://localhost" },
      butlerApp: {
        decideSessionPlan: async (request: unknown) => {
          requests.push(request);
          return response;
        },
      },
    },
  });
  useButlerStore.setState({
    activeChatId: "session-1",
    messages: [
      {
        id: "message-1",
        role: "assistant",
        text: "Draft",
        plan_document: {
          id: "plan-1",
          title: "Composer Plan",
          status: "draft",
          markdown: "# Draft Plan",
        },
      },
    ],
    refreshSessionView: async () => true,
  });

  const result = await useButlerStore
    .getState()
    .submitPlanDecision("session-1", "plan-1", "accept");

  expect(requests).toEqual([
    {
      sessionId: "session-1",
      planId: "plan-1",
      action: "accept",
      instruction: undefined,
    },
  ]);
  expect(result).toBe(response);
  expect(useButlerStore.getState().messages[0]?.plan_document?.status).toBe(
    "active",
  );
});
