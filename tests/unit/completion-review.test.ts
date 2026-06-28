import { expect, test } from "bun:test";
import { createEvidenceCapabilityReceipt } from "../../packages/butler-agent/src/agent/output/evidence/ledger.ts";
import { evaluateCompletionReviewOutcome } from "../../packages/butler-agent/src/agent/turn/completion-review.ts";

test("completion review returns gap when required evidence receipts are missing", () => {
  const outcome = evaluateCompletionReviewOutcome({
    requestText: "파일 내용을 검증해줘",
    candidateText: "요약:",
    requiredObligations: ["source_verified"],
    evidenceReceipts: [],
  });

  expect(outcome.kind).toBe("gap");
  if (outcome.kind === "gap") {
    expect(outcome.observation.kind).toBe("completion_gap");
    expect(outcome.observation.visibility).toBe("model");
    expect(outcome.observation.summary).toContain("Missing completion evidence");
  }
});

test("completion review returns waiting_user for explicit blocker receipt", () => {
  const outcome = evaluateCompletionReviewOutcome({
    requestText: "비공개 API 상태를 점검해줘",
    candidateText: "결과를 확인 중입니다.",
    requiredObligations: ["source_verified"],
    evidenceReceipts: [
      createEvidenceCapabilityReceipt({
        producer: { kind: "runtime", name: "completion_guard" },
        capability: "explicit_blocker",
        evidence_kind: "blocker",
        verified: true,
        maturity: "verified",
        confidence: 1,
        summary: "로그인이 필요해 진행할 수 없습니다.",
        limitations: ["로그인 상태가 확인되어야 합니다."],
        references: [{ url: "https://example.test/private" }],
        created_at: "2026-06-28T10:00:00.000Z",
      }),
    ],
  });

  expect(outcome.kind).toBe("waiting_user");
  if (outcome.kind === "waiting_user") {
    expect(outcome.observation.kind).toBe("public_decision_required");
    expect(outcome.observation.visibility).toBe("operator");
    expect(outcome.question).toContain("Missing completion evidence");
  }
});

test("completion review returns failed when terminal work states still miss evidence", () => {
  const outcome = evaluateCompletionReviewOutcome({
    requestText: "실행 결과를 확인해줘",
    candidateText: "요약했습니다.",
    requiredObligations: ["durable_artifact"],
    evidenceReceipts: [],
    workStreamTerminal: true,
  });

  expect(outcome.kind).toBe("failed");
  if (outcome.kind === "failed") {
    expect(outcome.publicSummary).toContain("Missing completion evidence");
  }
});

test("completion review is complete when required obligations are satisfied by typed receipts", () => {
  const outcome = evaluateCompletionReviewOutcome({
    requestText: "기록을 확인해줘",
    candidateText: "요청하신 항목을 정리했습니다.",
    requiredObligations: ["source_verified"],
    evidenceReceipts: [
      createEvidenceCapabilityReceipt({
        producer: { kind: "tool", name: "web_read" },
        capability: "source_verified",
        evidence_kind: "source_page",
        verified: true,
        maturity: "verified",
        confidence: 1,
        summary: "페이지를 확인해 읽기 완료했습니다.",
        satisfies: ["source_verified"],
        limitations: [],
        references: [{ url: "https://example.test/source" }],
        created_at: "2026-06-28T10:00:00.000Z",
      }),
    ],
  });

  expect(outcome.kind).toBe("complete");
});
