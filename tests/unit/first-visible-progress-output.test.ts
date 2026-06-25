import { expect, test } from "bun:test";
import {
  generateFirstVisibleProgressWithProvider,
  safeGeneratedFirstVisibleProgress,
} from "../../packages/butler-agent/src/agent/output/first-visible-progress.ts";
import type {
  ModelInvocation,
  ModelProviderAdapter,
} from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

function providerReturning(
  text: string,
  calls: ModelInvocation[] = [],
): ModelProviderAdapter {
  return {
    id: "fake-provider",
    capabilities: {
      supportsStreaming: false,
      supportsToolCalls: true,
      supportsImages: false,
      supportsAudio: false,
      supportsServerThreads: false,
      supportsReasoningConfig: true,
      supportsPromptCaching: false,
    },
    async invoke(input) {
      calls.push(input);
      return { text };
    },
  };
}

test("first visible progress generator asks the provider for public user-language prose", async () => {
  const calls: ModelInvocation[] = [];
  const note = await generateFirstVisibleProgressWithProvider(
    providerReturning("관련 맥락을 먼저 좁혀보겠습니다.", calls),
    {
      text: "새 채팅 화면이 바로 바뀌지 않습니다.",
      model: "openai/gpt-5.5-codex",
    },
  );

  expect(note).toBe("관련 맥락을 먼저 좁혀보겠습니다.");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.metadata).toMatchObject({
    purpose: "app_first_visible_progress",
  });
  expect(calls[0]?.toolChoice).toBe("none");
  expect(calls[0]?.reasoning).toMatchObject({ effort: "low" });
  expect(calls[0]?.messages[0]?.content).toContain(
    "새 채팅 화면이 바로 바뀌지 않습니다.",
  );
});

test("first visible progress sanitizer rejects unsafe or evidence-claiming text", () => {
  expect(safeGeneratedFirstVisibleProgress("<think>private</think>")).toBeNull();
  expect(
    safeGeneratedFirstVisibleProgress("파일을 이미 확인했고 결과를 검증했습니다."),
  ).toBeNull();
  expect(
    safeGeneratedFirstVisibleProgress("  \"필요한 맥락부터 정리하겠습니다.\"  "),
  ).toBe("필요한 맥락부터 정리하겠습니다.");
});
