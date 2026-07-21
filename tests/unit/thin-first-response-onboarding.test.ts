import { expect, test } from "bun:test";
import type { RuntimeTurnInput } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import {
  shouldUseThinFirstResponse,
} from "../../packages/butler-agent/src/agent/turn/native/turn-runner/thin-first-response.ts";
import type {
  NativeStoredSessionConfig,
} from "../../packages/butler-agent/src/agent/turn/native/turn-runner/turn-runner-types.ts";import { normalizeTurnPrompt } from "../../packages/butler-agent/src/agent/turn/native/context/turn-prompt.ts";
import { promptUsageSectionsFromPrompt } from "../../packages/butler-agent/src/agent/turn/direct-turn-budget.ts";

const turnInput = {
  metadata: { thinFirstResponse: "app_default" },
} as unknown as RuntimeTurnInput;

const butlerSession = {
  init: { role: "butler" },
} as NativeStoredSessionConfig;

test("pending onboarding bypasses the thin first-response prompt", () => {
  expect(shouldUseThinFirstResponse({
    turnInput,
    session: butlerSession,
    plannedReview: null,
    promptContextSectionIds: ["first_chat_onboarding"],
  })).toBe(false);
});

test("completed onboarding keeps the App thin first-response optimization", () => {
  expect(shouldUseThinFirstResponse({
    turnInput,
    session: butlerSession,
    plannedReview: null,
    promptContextSectionIds: ["runtime_policy"],
  })).toBe(true);
});
test("normalized onboarding context is attributed and protects the full prompt path", () => {
  const normalized = normalizeTurnPrompt({
    handle: {
      sessionId: "butler/onboarding-route-test",
      role: "butler",
      runtimeAdapterId: "native-tool-loop",
    },
    provider: {} as RuntimeTurnInput["provider"],
    model: "openai/test",
    input: { text: "온보딩을 시작하자." },
    metadata: {
      thinFirstResponse: "app_default",
      promptContext: [
        "## First-Chat Onboarding",
        "첫 대화 온보딩이 아직 완료되지 않았습니다.",
        "다음 우선 질문: principal_name",
      ].join("\n"),
    },
  }, {
    butlerData: "C:\\butler-onboarding-route-test",
    recentConversationTokenBudget: 128,
    skipRecentConversation: true,
  });
  const sections = promptUsageSectionsFromPrompt(normalized);

  expect(sections.map((section) => section.id)).toContain("first_chat_onboarding");
  expect(shouldUseThinFirstResponse({
    turnInput,
    session: butlerSession,
    plannedReview: null,
    promptContextSectionIds: sections.map((section) => section.id),
  })).toBe(false);
});