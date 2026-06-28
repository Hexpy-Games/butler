import { expect, test } from "bun:test";
import { createEvidenceCapabilityReceipt } from "../../packages/butler-agent/src/agent/output/evidence/ledger.ts";
import { evidenceReceiptsFromResult } from "../../packages/butler-agent/src/agent/output/evidence/receipts.ts";
import { evaluateCompletionReviewOutcome } from "../../packages/butler-agent/src/agent/turn/completion-review.ts";
import type { EvidenceReceiptType } from "../../packages/butler-agent/src/agent/turn/native/output/tool-types.ts";

test("completion review returns gap when required evidence receipts are missing", () => {
  const outcome = evaluateCompletionReviewOutcome({
    requestText: "파일 내용을 검증해줘",
    candidateText: "요약:",
    requiredObligations: ["source_verified"],
    evidenceReceipts: [],
  });

  expect(outcome.status).toBe("gap");
  if (outcome.status === "gap") {
    expect(outcome.observation.kind).toBe("completion_gap");
    expect(outcome.observation.summary).toBe("Missing completion evidence for: source_verified.");
    expect(outcome.observation.modelVisibleContent).toContain("next-step: Missing completion evidence for: source_verified.");
    expect(outcome.evidenceRefs).toEqual([]);
  }
});

test("completion review stays pure and returns concrete gaps for candidate-only receipts", () => {
  const receipt = {
    receipt_id: "candidate-source-receipt",
    schema_version: "evidence-capability.v1",
    producer: { kind: "tool", name: "web_read" },
    capability: "source_verified",
    evidence_kind: "source_page",
    verified: false,
    maturity: "candidate",
    confidence: 0.4,
    summary: "A source was mentioned but not verified.",
    satisfies: ["source_verified"],
    limitations: ["The source page was not fetched."],
    references: [{ url: "https://example.test/source" }],
    created_at: "2026-06-28T10:00:00.000Z",
  };
  const input = Object.freeze({
    requestText: "Verify this source.",
    candidateText: "I checked it.",
    requiredObligations: Object.freeze(["source_verified"] as const),
    evidenceReceipts: Object.freeze([Object.freeze(receipt)]),
    observations: Object.freeze([]),
    workStreamTerminal: false,
    todoTerminal: false,
  });

  const outcome = evaluateCompletionReviewOutcome(input);

  expect(outcome.status).toBe("gap");
  if (outcome.status === "gap") {
    expect(outcome.observation.summary).toBe("Missing completion evidence for: source_verified.");
    expect(outcome.observation.modelVisibleContent).toContain("request: Verify this source.");
    expect(outcome.observation.modelVisibleContent).toContain("candidate: I checked it.");
    expect(outcome.evidenceRefs).toContain(`receipt:${receipt.receipt_id}`);
    expect(outcome.evidenceRefs).toContain("url:https://example.test/source");
  }
  expect(input.evidenceReceipts).toHaveLength(1);
  expect(input.requiredObligations).toEqual(["source_verified"]);
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

  expect(outcome.status).toBe("waiting_user");
  if (outcome.status === "waiting_user") {
    expect(outcome.question).toContain("Missing completion evidence");
    expect(outcome.evidenceRefs.length).toBeGreaterThan(0);
    expect(outcome.evidenceRefs.some((ref) => ref.startsWith("receipt:"))).toBe(true);
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

  expect(outcome.status).toBe("failed");
  if (outcome.status === "failed") {
    expect(outcome.publicSummary).toContain("Missing completion evidence");
    expect(outcome.evidenceRefs).toEqual([]);
  }
});

test("completion review returns gap when completed todo state still misses evidence", () => {
  const outcome = evaluateCompletionReviewOutcome({
    requestText: "검증 태스크까지 완료해줘",
    candidateText: "검증 태스크를 마쳤습니다.",
    requiredObligations: ["command_executed"],
    evidenceReceipts: [],
    todoTerminalState: "completed",
  });

  expect(outcome.status).toBe("gap");
  if (outcome.status === "gap") {
    expect(outcome.observation.kind).toBe("completion_gap");
    expect(outcome.observation.summary).toBe("Missing completion evidence for: command_executed.");
    expect(outcome.observation.modelVisibleContent).toContain("next-step: Missing completion evidence for: command_executed.");
  }
});

test("completion review returns gap when cancelled todo state still misses evidence", () => {
  const outcome = evaluateCompletionReviewOutcome({
    requestText: "검증 태스크까지 완료해줘",
    candidateText: "검증 태스크가 취소되었습니다.",
    requiredObligations: ["command_executed"],
    evidenceReceipts: [],
    todoTerminalState: "cancelled",
  });

  expect(outcome.status).toBe("gap");
});

test("completion review is complete when required obligations are satisfied by typed receipts", () => {
  const evidence = createEvidenceCapabilityReceipt({
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
  });
  const outcome = evaluateCompletionReviewOutcome({
    requestText: "기록을 확인해줘",
    candidateText: "요청하신 항목을 정리했습니다.",
    requiredObligations: ["source_verified"],
    evidenceReceipts: [evidence],
  });

  expect(outcome.status).toBe("complete");
  if (outcome.status === "complete") {
    expect(outcome.evidenceRefs).toContain("url:https://example.test/source");
    expect(outcome.evidenceRefs).toContain(`receipt:${evidence.receipt_id}`);
  }
});

test("completion review reports waiting_user when an explicit blocker appears with other satisfied receipts", () => {
  const outcome = evaluateCompletionReviewOutcome({
    requestText: "작업 근거를 정리해줘",
    candidateText: "요약했습니다.",
    requiredObligations: ["source_verified", "command_executed"],
    evidenceReceipts: [
      createEvidenceCapabilityReceipt({
        producer: { kind: "runtime", name: "initial-receiver" },
        capability: "command_executed",
        evidence_kind: "execution_result",
        verified: true,
        maturity: "verified",
        confidence: 1,
        summary: "명령 실행 근거가 확인되었습니다.",
        satisfies: ["command_executed"],
        limitations: [],
        references: [{ task_id: "cmd-1" }],
        created_at: "2026-06-28T10:00:00.000Z",
      }),
      {
        receipt_id: "ecr-late-failed",
        schema_version: "evidence-capability.v1",
        producer: { kind: "runtime", name: "later-receiver" },
        capability: "source_verified",
        evidence_kind: "source_page",
        maturity: "verified",
        confidence: 1,
        verified: true,
        summary: "명령 실행 근거는 누락되었습니다.",
        limitations: [],
        satisfies: ["source_verified"],
        references: [],
        created_at: "2026-06-28T11:00:00.000Z",
      },
      createEvidenceCapabilityReceipt({
        producer: { kind: "runtime", name: "completion-guard" },
        capability: "explicit_blocker",
        evidence_kind: "blocker",
        verified: true,
        maturity: "verified",
        confidence: 1,
        summary: "로그인 필요한 블로커 상태입니다.",
        limitations: ["로그인 상태를 확인하세요."],
        references: [{ url: "https://example.test/private" }],
        created_at: "2026-06-28T11:01:00.000Z",
      }),
    ],
  });

  expect(outcome.status).toBe("waiting_user");
});

test("completion review marks contradiction when failed evidence follows later than satisfied evidence", () => {
  const outcome = evaluateCompletionReviewOutcome({
    requestText: "작업 근거를 정리해줘",
    candidateText: "요약했습니다.",
    requiredObligations: ["source_verified"],
    evidenceReceipts: [
      createEvidenceCapabilityReceipt({
        producer: { kind: "runtime", name: "initial-receiver" },
        capability: "source_verified",
        evidence_kind: "source_page",
        verified: true,
        maturity: "verified",
        confidence: 1,
        summary: "초기 근거가 확인되었습니다.",
        satisfies: ["source_verified"],
        limitations: [],
        references: [{ url: "https://example.test/a" }],
        created_at: "2026-06-28T10:00:00.000Z",
      }),
      {
        receipt_id: "ecr-contradiction-later-failed",
        schema_version: "evidence-capability.v1",
        producer: { kind: "runtime", name: "later-receiver" },
        capability: "source_verified",
        evidence_kind: "source_page",
        maturity: "verified",
        confidence: 1,
        verified: true,
        summary: "같은 근거가 취소되었습니다.",
        limitations: [],
        satisfies: ["source_verified"],
        references: [],
        created_at: "2026-06-28T11:00:00.000Z",
      },
    ],
  });

  expect(outcome.status).toBe("gap");
  if (outcome.status === "gap") {
    expect(outcome.observation.summary).toContain("Conflicting completion evidence rows exist");
  }
});

test("completion review supports command executed receipts through typed evidence kinds", () => {
  const outcome = evaluateCompletionReviewOutcome({
    requestText: "명령 실행 결과를 저장해줘",
    candidateText: "결과를 저장했습니다.",
    requiredObligations: ["command_executed"],
    evidenceReceipts: [
      createEvidenceCapabilityReceipt({
        producer: { kind: "tool", name: "run_command" },
        capability: "command_executed",
        evidence_kind: "execution_result",
        verified: true,
        maturity: "verified",
        confidence: 0.9,
        summary: "명령 실행이 정상 완료되었습니다.",
        satisfies: ["command_executed"],
        limitations: [],
        references: [{ task_id: "cmd-1" }],
        created_at: "2026-06-28T10:00:00.000Z",
      }),
    ],
  });

  expect(outcome.status).toBe("complete");
  if (outcome.status === "complete") {
    expect(outcome.evidenceRefs).toContain("task:cmd-1");
  }
});

test("evidence receipt parser supports C02 reviewer receipt taxonomy", () => {
  const receiptTypes: EvidenceReceiptType[] = [
    "test",
    "file_edit",
    "artifact",
    "browser_observation",
    "app_observation",
    "project_ledger_operation",
    "review",
    "pull_request",
    "release",
    "route_verification",
    "user_decision_required",
    "runtime_fault",
    "provider_fault",
    "cancellation",
    "not_required",
  ];
  const receipts = evidenceReceiptsFromResult({
    evidence_receipts: receiptTypes.map((receiptType) => ({
      schema: "butler.evidence-receipt.v1",
      id: `receipt-${receiptType}`,
      producer: { kind: receiptType === "provider_fault" ? "provider" : "runtime", name: "completion-review-test" },
      receiptType,
      verified: true,
      covers: [receiptType],
      summary: `${receiptType} receipt`,
      references: [{ kind: "tool_output", ref: `tool-${receiptType}` }],
    })),
  });

  expect(receipts.map((receipt) => receipt.receiptType)).toEqual(receiptTypes);
});
