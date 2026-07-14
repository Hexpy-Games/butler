import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  cancelCurrentFinalCandidate,
  commitFinalCandidateProposal,
  markFinalCandidateDelivered,
  readCurrentFinalCandidate,
  updateFinalCandidateReview,
} from "../../packages/butler-agent/src/agent/turn/native/turn-runner/final-candidate-review-store.ts";
import { compileGroundingReviewCapsule } from "../../packages/butler-agent/src/agent/turn/native/turn-runner/review-capsule-compiler.ts";
import { publicWebSearchEvidenceItems } from "../../packages/butler-agent/src/agent/output/evidence/public-web-evidence.ts";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import {
  createTurnContextAtomId,
  persistTurnContextAtom,
} from "../../packages/butler-agent/src/agent/turn/turn-continuation-context.ts";
import { cancelPersistedRuntimeTurn } from "../../packages/butler-agent/src/agent/turn/principal-turn-cancellation.ts";

const tempDirs: string[] = [];
afterEach(() => tempDirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function tempData(): string {
  const path = mkdtempSync(join(tmpdir(), "butler-final-candidate-review-"));
  tempDirs.push(path);
  return path;
}

function proposal(butlerData: string, candidateText = "Answer one") {
  return {
    butlerData,
    turnId: "turn-review-1",
    sessionId: "session-review-1",
    contractId: "contract-review-1",
    userMessageId: "message-review-1",
    userText: "정확한 사용자 요청입니다.",
    candidateText,
    evidence: { items: [], attempts: [] },
    providerAdapterId: "openai",
    effectiveModel: "openai/gpt-5.6-sol",
  };
}

test("candidate checkpoint and pending review owner are published atomically and idempotently", () => {
  const butlerData = tempData();
  const first = commitFinalCandidateProposal(proposal(butlerData));
  const duplicate = commitFinalCandidateProposal(proposal(butlerData));

  expect(duplicate).toEqual(first);
  expect(first).toMatchObject({
    state: "pending_review",
    revision: 1,
    effective_model: "openai/gpt-5.6-sol",
    review_job: { state: "pending", next_node_id: "grounding_review" },
  });
  expect(readCurrentFinalCandidate({ butlerData, turnId: first.turn_id })).toEqual(first);
  expect(() => commitFinalCandidateProposal({
    ...proposal(butlerData),
    effectiveModel: "openai/gpt-5.5",
  })).toThrow("final_candidate_effective_model_identity_conflict");
});

test("a revised candidate supersedes rather than overwrites the prior revision", () => {
  const butlerData = tempData();
  const first = commitFinalCandidateProposal(proposal(butlerData));
  updateFinalCandidateReview({
    butlerData,
    turnId: first.turn_id,
    candidateId: first.candidate_id,
    state: "review_gap_pending",
    gapFingerprint: "gap-one",
  });
  const revised = commitFinalCandidateProposal(proposal(butlerData, "Answer two"));

  expect(revised.revision).toBe(2);
  expect(revised.candidate_id).not.toBe(first.candidate_id);
  expect(readCurrentFinalCandidate({ butlerData, turnId: first.turn_id })?.candidate_text).toBe("Answer two");
});

test("review capsule contains exact request and candidate but cannot inherit execution context", () => {
  const items = publicWebSearchEvidenceItems({
    results: [{
      title: "Source",
      url: "https://example.com/source",
      snippet: "Bounded evidence.",
      source: "Example",
    }],
  });
  const compiled = compileGroundingReviewCapsule({
    userText: "원문 요청",
    candidateText: "답변 ([Source](https://example.com/source)).",
    evidenceRevision: "revision-1",
    evidenceItems: items,
    successfulSearches: 1,
    searchResultCount: 1,
    successfulReads: 0,
  });

  expect(compiled.prompt).toContain("원문 요청");
  expect(compiled.prompt).toContain("답변");
  expect(compiled.prompt).not.toContain("hot_cache");
  expect(compiled.prompt).not.toContain("recent_conversation");
  expect(compiled.capsule.user_request_spans[0]).toMatchObject({
    utf8_start: 0,
    utf8_end: Buffer.byteLength("원문 요청", "utf8"),
  });
  expect(compiled.capsule.coverage.evidence_item_ids).toEqual([items[0]!.evidence_item_id]);
});

test("capsule keeps every pinned evidence item and prioritizes candidate citations without latest-N loss", () => {
  const items = publicWebSearchEvidenceItems({
    results: Array.from({ length: 20 }, (_, index) => ({
      title: `Source ${index}`,
      url: `https://source-${index}.example/item`,
      snippet: `Evidence ${index}`,
      source: `Source ${index}`,
    })),
  });
  const cited = items[2]!;
  const compiled = compileGroundingReviewCapsule({
    userText: "request",
    candidateText: `candidate [citation](${cited.source_url})`,
    evidenceRevision: "revision-20",
    evidenceItems: items,
    successfulSearches: 1,
    searchResultCount: 20,
    successfulReads: 0,
  });

  expect(compiled.capsule.evidence_items).toHaveLength(20);
  expect(compiled.capsule.evidence_items[0]?.evidence_item_id).toBe(cited.evidence_item_id);
  expect(new Set(compiled.capsule.coverage.evidence_item_ids).size).toBe(20);
});

test("Sandy-shaped execution context cannot inflate the independent review request", () => {
  const items = publicWebSearchEvidenceItems({
    results: Array.from({ length: 30 }, (_, index) => ({
      title: `Evidence ${index}`,
      url: `https://evidence-${index}.example/item`,
      snippet: `Bounded excerpt ${index} ${"x".repeat(160)}`,
      source: `Publisher ${index}`,
    })),
  });
  const executionPrompt = [
    "persona:" + "p".repeat(30_000),
    "recent_conversation:" + "r".repeat(30_000),
    "hot_cache:" + "h".repeat(30_000),
    "tool_schemas:" + "t".repeat(30_000),
  ].join("\n");
  const userText = "샌디 세션에서 확인한 사실만 근거로 최종 답변해 주세요.";
  const candidateText = "검증된 최종 후보입니다. ".repeat(35).slice(0, 839);
  const compiled = compileGroundingReviewCapsule({
    userText,
    candidateText,
    evidenceRevision: "sandy-evidence-revision",
    evidenceItems: items,
    successfulSearches: 10,
    searchResultCount: 30,
    successfulReads: 1,
  });

  expect(executionPrompt.length).toBeGreaterThan(120_000);
  expect(compiled.prompt).not.toContain(executionPrompt.slice(0, 1_000));
  expect(compiled.prompt).not.toContain("recent_conversation:");
  expect(compiled.prompt).not.toContain("hot_cache:");
  expect(compiled.capsule.user_request_spans[0]?.text).toBe(userText);
  expect(compiled.capsule.candidate_spans[0]?.text).toBe(candidateText);
  expect(compiled.capsule.evidence_items).toHaveLength(30);
  expect(compiled.utf8Bytes).toBeLessThan(40_000);
});

test("review interruption and cancellation preserve one owned candidate instead of regenerating it", () => {
  const butlerData = tempData();
  const candidate = commitFinalCandidateProposal(proposal(butlerData, "durable answer"));
  updateFinalCandidateReview({
    butlerData,
    turnId: candidate.turn_id,
    candidateId: candidate.candidate_id,
    state: "reviewing",
  });
  updateFinalCandidateReview({
    butlerData,
    turnId: candidate.turn_id,
    candidateId: candidate.candidate_id,
    state: "pending_review",
  });
  const resumed = commitFinalCandidateProposal(proposal(butlerData, "durable answer"));

  expect(resumed.candidate_id).toBe(candidate.candidate_id);
  expect(resumed.revision).toBe(1);
  expect(cancelCurrentFinalCandidate({ butlerData, turnId: candidate.turn_id })).toMatchObject({
    candidate_id: candidate.candidate_id,
    state: "cancelled",
    review_job: { state: "cancelled" },
  });
});

test("terminal delivery is committed once using the real durable outbound action id", () => {
  const butlerData = tempData();
  const candidate = commitFinalCandidateProposal(proposal(butlerData));
  updateFinalCandidateReview({
    butlerData,
    turnId: candidate.turn_id,
    candidateId: candidate.candidate_id,
    state: "accepted",
    reviewedText: candidate.candidate_text,
  });
  updateFinalCandidateReview({
    butlerData,
    turnId: candidate.turn_id,
    candidateId: candidate.candidate_id,
    state: "delivery_pending",
  });

  const delivered = markFinalCandidateDelivered({
    butlerData,
    turnId: candidate.turn_id,
    deliveryActionId: "outbound-final-1",
  });
  const replayed = markFinalCandidateDelivered({
    butlerData,
    turnId: candidate.turn_id,
    deliveryActionId: "outbound-final-1",
  });

  expect(delivered).toMatchObject({ state: "delivered", delivery_action_id: "outbound-final-1" });
  expect(replayed).toEqual(delivered);
  expect(() => markFinalCandidateDelivered({
    butlerData,
    turnId: candidate.turn_id,
    deliveryActionId: "outbound-final-2",
  })).toThrow("final_candidate_delivery_identity_conflict");
});

test("principal turn cancellation atomically cancels the persisted review owner", () => {
  const butlerData = tempData();
  const candidate = commitFinalCandidateProposal({
    ...proposal(butlerData),
    turnId: "turn-principal-cancel",
  });

  cancelPersistedRuntimeTurn({ butlerData, turnId: candidate.turn_id });

  expect(readCurrentFinalCandidate({ butlerData, turnId: candidate.turn_id })).toMatchObject({
    candidate_id: candidate.candidate_id,
    state: "cancelled",
    review_job: { state: "cancelled" },
  });
});

test("scheduler restart resumes the owned review candidate without invoking execution again", async () => {
  const butlerData = tempData();
  const candidate = commitFinalCandidateProposal({
    ...proposal(butlerData, "재실행 없이 검토를 재개한 답변입니다."),
    turnId: "turn-review-resume",
    sessionId: "worker/review-resume",
    contractId: null,
  });
  persistTurnContextAtom({
    butlerData,
    sessionId: candidate.session_id,
    turnId: candidate.turn_id,
    state: "continuing",
    sourceErrorCode: "review_request_prompt_tokens_lease_exhausted",
    reason: "Resume the persisted review node.",
    userRequest: { id: candidate.user_message_id },
    providerAdapterId: candidate.provider_adapter_id,
    effectiveModel: candidate.effective_model,
    finalCandidateReview: {
      candidateId: candidate.candidate_id,
      reviewJobId: candidate.review_job.job_id,
      state: candidate.state,
      revision: candidate.revision,
    },
  });
  let executionCalls = 0;
  const runtime = new NativeToolLoopRuntime({
    butlerData,
    butlerHome: butlerData,
    disableAutomaticRecall: true,
    runFunctionToolPromptText: async () => {
      executionCalls += 1;
      return "regenerated answer";
    },
  });
  const handle = await runtime.createSession({
    sessionId: candidate.session_id,
    role: "worker",
    workspacePath: butlerData,
    systemPrompt: "Worker",
  });
  const result = await runtime.runTurn({
    handle,
    provider: {
      id: candidate.provider_adapter_id,
      capabilities: {
        supportsStreaming: false,
        supportsToolCalls: true,
        supportsImages: false,
        supportsAudio: false,
        supportsServerThreads: false,
        supportsReasoningConfig: true,
        supportsPromptCaching: false,
        supportsStructuredOutputs: false,
      },
      invoke: async () => ({ text: "must not run" }),
    },
    model: "openai/gpt-5.6-sol",
    input: { text: candidate.user_message_text },
    metadata: {
      turnId: candidate.turn_id,
      schedulerContinuation: {
        contextAtomId: createTurnContextAtomId(candidate.session_id, candidate.turn_id),
      },
      runtimePolicy: { completionReview: "disabled" },
    },
  });

  expect(executionCalls).toBe(0);
  expect(result.text).toBe(candidate.candidate_text);
  expect(readCurrentFinalCandidate({ butlerData, turnId: candidate.turn_id })).toMatchObject({
    candidate_id: candidate.candidate_id,
    state: "delivery_pending",
    effective_model: "openai/gpt-5.6-sol",
  });
});
