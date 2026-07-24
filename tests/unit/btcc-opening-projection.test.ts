import { expect, test } from "bun:test";
import { publishOpeningDecision } from
  "../../packages/butler-agent/src/agent/btcc/turn/turn-progress.ts";
import { projectTurnProgress } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/project-turn-progress.ts";

test("projects the committed model-authored Opening decision without rewriting it", async () => {
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const observer = projectTurnProgress(async (event) => {
    events.push(event);
  });

  await publishOpeningDecision(observer, "turn-opening", 2, {
    kind: "opening_continuation",
    route: "managed",
    projection: {
      ref: { id: "opening-decision-1", sha256: "opening-sha-1" },
      summary: "요청의 목표와 완료 조건을 먼저 정리하겠습니다.",
      rationale: "원래 의도를 보존한 계획이 필요한 관리 작업입니다.",
      nextStep: "관련 스펙을 확인하고 Work와 Task를 구성하겠습니다.",
      contentSha256: "opening-content-sha-1",
    },
  });

  expect(events).toEqual([{
    kind: "assistant.decision",
    payload: {
      decisionId: "opening-decision-1",
      role: "opening",
      summary: "요청의 목표와 완료 조건을 먼저 정리하겠습니다.",
      rationale: "원래 의도를 보존한 계획이 필요한 관리 작업입니다.",
      nextStep: "관련 스펙을 확인하고 Work와 Task를 구성하겠습니다.",
      source: "model-authored",
      firstVisible: true,
      turnRevision: 2,
    },
  }]);
});
