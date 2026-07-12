import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  publicWebReadEvidenceItems,
  publicWebSearchEvidenceItems,
} from "../../packages/butler-agent/src/agent/output/evidence/public-web-evidence.ts";
import { createDirectTurnBudget } from "../../packages/butler-agent/src/agent/turn/direct-turn-budget.ts";
import {
  compileTurnContract,
  TURN_CONTRACT_DECISION_SCHEMA,
  TurnContractStore,
} from "../../packages/butler-agent/src/agent/turn/turn-contract.ts";
import { reviewGroundedAnswerCandidate } from "../../packages/butler-agent/src/agent/turn/native/turn-runner/grounded-answer-review.ts";
import type { NativeTurnRunnerDeps } from "../../packages/butler-agent/src/agent/turn/native/turn-runner/turn-runner-types.ts";
import type { RuntimeTurnInput } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

const tempDirs: string[] = [];
afterEach(() => tempDirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function tempData(): string {
  const path = mkdtempSync(join(tmpdir(), "butler-grounding-review-"));
  tempDirs.push(path);
  return path;
}

function contract(butlerData: string) {
  const value = compileTurnContract({
    decision: {
      schema_version: TURN_CONTRACT_DECISION_SCHEMA,
      decision_id: "decision-grounding-review",
      action: "tool_answer",
      evidence_domain: "public_web",
      deliverables: ["grounded_answer"],
      public_summary: "Answer from public evidence.",
    },
    obligationRequirements: {
      grounded_answer: {
        deliverable: "grounded_answer",
        target_kind: "public",
        target_id: "public-web",
        generation: 1,
      },
    },
  });
  new TurnContractStore(butlerData).create(value);
  return value;
}

function turnInput(transport: "json_schema" | "function_tool" = "json_schema"): RuntimeTurnInput {
  return {
    handle: { sessionId: "general-chat", role: "butler", runtimeAdapterId: "native" },
    provider: {
      id: "test-provider",
      capabilities: {
        supportsStreaming: false,
        supportsToolCalls: true,
        supportsImages: false,
        supportsAudio: false,
        supportsServerThreads: false,
        supportsReasoningConfig: true,
        supportsPromptCaching: false,
        supportsStructuredOutputs: true,
        structuredDecisionTransport: transport,
      },
      invoke: async () => ({ text: "" }),
    },
    model: "openai/test",
    input: { text: "What happened?" },
  };
}

function deps(butlerData: string, review: Record<string, unknown>): NativeTurnRunnerDeps {
  return {
    runtimeId: "native",
    promptRunner: async () => JSON.stringify(review),
    toolPromptRunner: async () => JSON.stringify(review),
    butlerHome: butlerData,
    butlerData,
    messageLanguage: "en",
    automaticRecallEnabled: false,
    runAutomaticRecall: async ({ cue }) => ({ cue, seeds: [], items: [], abstained: true, diagnostics: [] }),
  };
}

function supportedReview(itemIds: string[]) {
  return {
    schema_version: "butler.grounded-answer-review.v1",
    outcome: "supported",
    candidate_safe_to_deliver: true,
    next_action: "accept",
    summary: "The material claim is supported by the supplied excerpt.",
    claims: [{
      claim_id: "claim-1",
      claim_text: "The event happened on July 12.",
      support: "direct",
      evidence_item_ids: itemIds,
      limitations: ["Only the reported date was checked."],
    }],
    citation_item_ids: itemIds,
    limitations: [],
  };
}

test("search evidence can ground an answer without a mandatory web_read", async () => {
  const butlerData = tempData();
  const activeContract = contract(butlerData);
  const items = publicWebSearchEvidenceItems({
    observedAt: new Date("2026-07-13T00:00:00.000Z"),
    results: [{
      title: "Event report",
      url: "https://news.example/event",
      snippet: "The event happened on July 12.",
      source: "Example News",
      published_at: "2026-07-12",
    }],
  });
  const outcome = await reviewGroundedAnswerCandidate({
    turnInput: turnInput(),
    deps: deps(butlerData, supportedReview([items[0]!.evidence_item_id])),
    turnId: "turn-1",
    turnBudget: createDirectTurnBudget("turn-1"),
    prompt: "When did the event happen?",
    candidateText: "The event happened on July 12 ([Example News](https://news.example/event)).",
    audit: [{ name: "web_search", args: { query: "event date" }, ok: true, result: {
      ok: true,
      results: [{ url: "https://news.example/event" }],
      public_web_evidence_items: items,
    } }],
    contract: activeContract,
  });

  expect(outcome.kind).toBe("accepted");
  const stored = new TurnContractStore(butlerData).read(activeContract.contract_id)!;
  expect(stored.evidence_receipt_ids).toHaveLength(1);
  expect(new TurnContractStore(butlerData).evidenceFor(stored)[0]).toMatchObject({
    deliverable: "grounded_answer",
    producer: "public_web",
    item_ids: [items[0]!.evidence_item_id],
  });
});

test("runtime rejects reviewer citations that do not exist in tool evidence", async () => {
  const butlerData = tempData();
  const activeContract = contract(butlerData);
  await expect(reviewGroundedAnswerCandidate({
    turnInput: turnInput(),
    deps: deps(butlerData, supportedReview(["hallucinated-evidence-id"])),
    turnId: "turn-2",
    turnBudget: createDirectTurnBudget("turn-2"),
    prompt: "What happened?",
    candidateText: "Something happened.",
    audit: [{ name: "web_search", args: { query: "event" }, ok: true, result: {
      ok: true,
      results: [],
      public_web_evidence_items: [],
    } }],
    contract: activeContract,
  })).rejects.toThrow("grounding_review_citation_invalid");
});

test("reviewer-declared citations must appear in the candidate answer", async () => {
  const butlerData = tempData();
  const activeContract = contract(butlerData);
  const items = publicWebSearchEvidenceItems({
    results: [{
      title: "Event report",
      url: "https://news.example/event",
      snippet: "The event happened on July 12.",
      source: "Example News",
    }],
  });
  const outcome = await reviewGroundedAnswerCandidate({
    turnInput: turnInput(),
    deps: deps(butlerData, supportedReview([items[0]!.evidence_item_id])),
    turnId: "turn-citation",
    turnBudget: createDirectTurnBudget("turn-citation"),
    prompt: "When did it happen?",
    candidateText: "The event happened on July 12.",
    audit: [{ name: "web_search", args: { query: "event" }, ok: true, result: {
      ok: true,
      results: [{ url: "https://news.example/event" }],
      public_web_evidence_items: items,
    } }],
    contract: activeContract,
  });

  expect(outcome).toMatchObject({ kind: "gap", nextMode: "final_synthesis" });
  expect(new TurnContractStore(butlerData).read(activeContract.contract_id)!.evidence_receipt_ids).toEqual([]);
});

test("observed no-result limitation can finish without fabricated citations", async () => {
  const butlerData = tempData();
  const activeContract = contract(butlerData);
  const review = {
    schema_version: "butler.grounded-answer-review.v1",
    outcome: "no_result",
    candidate_safe_to_deliver: true,
    next_action: "accept",
    summary: "The answer accurately reports that the search found no result.",
    claims: [],
    citation_item_ids: [],
    limitations: ["No matching public result was returned."],
  };
  const outcome = await reviewGroundedAnswerCandidate({
    turnInput: turnInput(),
    deps: deps(butlerData, review),
    turnId: "turn-3",
    turnBudget: createDirectTurnBudget("turn-3"),
    prompt: "Find the announcement.",
    candidateText: "공개 검색에서 해당 공지를 찾지 못했습니다.",
    audit: [{ name: "web_search", args: { query: "announcement" }, ok: true, result: {
      ok: true,
      results: [],
      public_web_evidence_items: [],
    } }],
    contract: activeContract,
  });

  expect(outcome.kind).toBe("accepted");
});

test("unsafe semantic review returns a continuation gap instead of a verified receipt", async () => {
  const butlerData = tempData();
  const activeContract = contract(butlerData);
  const review = {
    schema_version: "butler.grounded-answer-review.v1",
    outcome: "insufficient",
    candidate_safe_to_deliver: false,
    next_action: "rewrite_with_limitations",
    summary: "The candidate overstates the available evidence.",
    claims: [{
      claim_id: "claim-1",
      claim_text: "The event definitely happened.",
      support: "unsupported",
      evidence_item_ids: [],
      limitations: ["No evidence item supports the claim."],
    }],
    citation_item_ids: [],
    limitations: ["The answer must state the evidence limitation."],
  };
  const outcome = await reviewGroundedAnswerCandidate({
    turnInput: turnInput(),
    deps: deps(butlerData, review),
    turnId: "turn-4",
    turnBudget: createDirectTurnBudget("turn-4"),
    prompt: "Did it happen?",
    candidateText: "It definitely happened.",
    audit: [{ name: "web_search", args: { query: "event" }, ok: true, result: {
      ok: true,
      results: [],
      public_web_evidence_items: [],
    } }],
    contract: activeContract,
  });

  expect(outcome).toMatchObject({ kind: "gap", nextMode: "final_synthesis" });
  expect(new TurnContractStore(butlerData).read(activeContract.contract_id)!.evidence_receipt_ids).toEqual([]);
});

test("a successful web_read remains insufficient when its content does not support the claim", async () => {
  const butlerData = tempData();
  const activeContract = contract(butlerData);
  const items = publicWebReadEvidenceItems({
    sourceUrl: "https://news.example/unrelated",
    markdown: "This page discusses ticket sales but does not name the winner.",
  });
  const review = {
    schema_version: "butler.grounded-answer-review.v1",
    outcome: "insufficient",
    candidate_safe_to_deliver: false,
    next_action: "gather_more_evidence",
    summary: "The read page does not support the claimed winner.",
    claims: [{
      claim_id: "claim-winner",
      claim_text: "Team A won the final.",
      support: "unsupported",
      evidence_item_ids: [],
      limitations: ["The page does not identify a winner."],
    }],
    citation_item_ids: [],
    limitations: ["A different source is needed."],
  };
  const outcome = await reviewGroundedAnswerCandidate({
    turnInput: turnInput(),
    deps: deps(butlerData, review),
    turnId: "turn-read-insufficient",
    turnBudget: createDirectTurnBudget("turn-read-insufficient"),
    prompt: "Who won?",
    candidateText: "Team A won the final.",
    audit: [{ name: "web_read", args: { url: "https://news.example/unrelated" }, ok: true, result: {
      ok: true,
      public_web_evidence_items: items,
    } }],
    contract: activeContract,
  });

  expect(outcome).toMatchObject({ kind: "gap", nextMode: "tool_decision" });
});

test("failed retrieval cannot be reclassified as a no-result answer", async () => {
  const butlerData = tempData();
  const activeContract = contract(butlerData);
  const review = {
    schema_version: "butler.grounded-answer-review.v1",
    outcome: "no_result",
    candidate_safe_to_deliver: true,
    next_action: "accept",
    summary: "No result was found.",
    claims: [],
    citation_item_ids: [],
    limitations: ["No result."],
  };
  await expect(reviewGroundedAnswerCandidate({
    turnInput: turnInput(),
    deps: deps(butlerData, review),
    turnId: "turn-provider-failed",
    turnBudget: createDirectTurnBudget("turn-provider-failed"),
    prompt: "Find the result.",
    candidateText: "결과를 찾지 못했습니다.",
    audit: [{ name: "web_search", args: { query: "result" }, ok: false, error: "provider unavailable" }],
    contract: activeContract,
  })).rejects.toThrow("grounding_review_no_result_unobserved");
});

test("function-tool structured providers run the same mandatory grounding review", async () => {
  const butlerData = tempData();
  const activeContract = contract(butlerData);
  const items = publicWebSearchEvidenceItems({
    results: [{
      title: "Event report",
      url: "https://news.example/event",
      snippet: "The event happened on July 12.",
      source: "Example News",
    }],
  });
  const review = supportedReview([items[0]!.evidence_item_id]);
  const functionDeps = deps(butlerData, review);
  functionDeps.toolPromptRunner = async (input) => {
    expect(input.toolChoice).toBe("required");
    expect(input.tools.map((tool) => tool.name)).toEqual(["submit_grounding_review"]);
    const output = await input.executeTool({
      name: "submit_grounding_review",
      args: review,
      rawArguments: JSON.stringify(review),
    });
    return await input.finalTextFromToolResult!({
      name: "submit_grounding_review",
      args: review,
      output,
    }) ?? "";
  };
  const outcome = await reviewGroundedAnswerCandidate({
    turnInput: turnInput("function_tool"),
    deps: functionDeps,
    turnId: "turn-function-review",
    turnBudget: createDirectTurnBudget("turn-function-review"),
    prompt: "When did it happen?",
    candidateText: "July 12 ([Example News](https://news.example/event)).",
    audit: [{ name: "web_search", args: { query: "event" }, ok: true, result: {
      ok: true,
      results: [{ url: "https://news.example/event" }],
      public_web_evidence_items: items,
    } }],
    contract: activeContract,
  });

  expect(outcome.kind).toBe("accepted");
});
