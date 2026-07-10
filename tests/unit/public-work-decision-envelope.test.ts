import { expect, test } from "bun:test";
import {
  publicDecisionStructuredFields,
  renderPublicDecisionContext,
} from "../../packages/butler-agent/src/agent/output/public-work/protocol.ts";
import {
  publicWorkDecisionsFromAssistantText,
  publicWorkDecisionPayload,
} from "../../packages/butler-agent/src/agent/output/public-work/decisions.ts";

test("decision envelope carries a typed repeat reason and concrete expected effect", () => {
  const text = [
    "title: Ledger 반영 대기 확인",
    "summary: 방금 갱신한 Ledger 상태를 다시 확인합니다.",
    "rationale: 비동기 인덱스 반영이 끝났는지 확인해야 다음 검증으로 이동할 수 있습니다.",
    "next_step: revision이 바뀌면 check를 실행합니다.",
    "expected_effect: project index revision이 직전 조회보다 증가합니다.",
    "repeat_reason: polling",
  ].join("\n");

  expect(publicDecisionStructuredFields(text)).toEqual([{
    blockTitle: "Ledger 반영 대기 확인",
    summary: "방금 갱신한 Ledger 상태를 다시 확인합니다.",
    rationale: "비동기 인덱스 반영이 끝났는지 확인해야 다음 검증으로 이동할 수 있습니다.",
    nextStep: "revision이 바뀌면 check를 실행합니다.",
    expectedEffect: "project index revision이 직전 조회보다 증가합니다.",
    repeatReason: "polling",
  }]);

  const [decision] = publicWorkDecisionsFromAssistantText({
    text,
    toolCalls: [{ name: "project_ledger_status", args: {} }],
    language: "ko",
    existingDecisions: [],
  });
  expect(decision).toMatchObject({
    expectedEffect: "project index revision이 직전 조회보다 증가합니다.",
    repeatReason: "polling",
  });
  expect(publicWorkDecisionPayload(decision!)).toMatchObject({
    decisionExpectedEffect: "project index revision이 직전 조회보다 증가합니다.",
    decisionRepeatReason: "polling",
  });
  expect(renderPublicDecisionContext([decision!])).toContain("repeat_reason: polling");
});

test("decision envelope rejects an untyped repeat reason", () => {
  const [decision] = publicWorkDecisionsFromAssistantText({
    text: [
      "title: Ledger 상태 재확인",
      "summary: Ledger 상태를 다시 확인합니다.",
      "rationale: 상태 변경 여부를 확인해야 다음 작업을 정할 수 있습니다.",
      "next_step: 확인 결과를 기준으로 다음 단계를 선택합니다.",
      "expected_effect: 상태 revision이 변경됩니다.",
      "repeat_reason: because_it_seems_useful",
    ].join("\n"),
    toolCalls: [{ name: "project_ledger_status", args: {} }],
    language: "ko",
    existingDecisions: [],
  });

  expect(decision).toBeUndefined();
});
