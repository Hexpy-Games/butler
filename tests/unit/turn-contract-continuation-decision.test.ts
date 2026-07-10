import { expect, test } from "bun:test";
import { createContractContinuationDecision } from "../../packages/butler-agent/src/agent/turn/native/turn-runner/turn-contract-continuation-decision.ts";

test("typed tool calls repair one visible path-specific continuation decision", () => {
  const decision = createContractContinuationDecision({
    active: {
      decision: {
        schema_version: "butler.turn-contract-decision.v1",
        decision_id: "typed-decision-1",
        action: "inspect",
        deliverables: ["status_report"],
        public_summary: "캐시 구현 함수를 확인합니다.",
        immediate_next_step: "검색 후보를 읽습니다.",
      },
      publicDecision: {
        decisionId: "public-decision-1",
        contractId: "contract-1",
        summary: "캐시 구현 함수를 확인합니다.",
        rationale: "실제 소스 근거가 필요합니다.",
        nextStep: "검색 후보를 읽습니다.",
        evidenceRefs: [],
        source: "principal-authored",
      },
      contract: {
        schema_version: "butler.compiled-turn-contract.v1",
        contract_id: "contract-1",
        decision_id: "typed-decision-1",
        decision_semantic_fingerprint: "inspect:status-report",
        action: "inspect",
        deliverables: ["status_report"],
        required_evidence: [],
        tracking_mode: "none",
        closeout_strategy: "noop",
        terminal_rule: "verified_report",
        evidence_receipt_ids: [],
        continuation_commit_ids: [],
        terminal_delivery_keys: [],
        state: "executing",
        generation: 1,
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
      },
    },
    toolCalls: [
      {
        name: "read_file",
        args: {
          path: "packages/butler-agent/src/integrations/providers/provider.ts",
          start_line: 690,
        },
      },
      {
        name: "read_file",
        args: {
          path: "packages/butler-agent/src/integrations/providers/control-plane.ts",
          start_line: 70,
        },
      },
    ],
    language: "ko",
    providerRound: 2,
  });

  expect(decision).toMatchObject({
    contractId: "contract-1",
    semanticBlockId: "contract-1:block:2",
    providerRound: 2,
    toolBatchSize: 2,
    source: "contract-derived",
    toolName: "read_file",
  });
  expect(decision.summary).toContain("provider.ts:690");
  expect(decision.summary).toContain("외 1개 관련 호출");
  expect(decision.rationale).toContain("typed contract");
  expect(decision.nextStep).toContain("최종 답변");
});
