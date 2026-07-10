import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearTurnContextAtom,
  createTurnContextAtomId,
  persistTurnContextAtom,
  readTurnContextAtom,
} from "../../packages/butler-agent/src/agent/turn/turn-continuation-context.ts";
import { isTerminalTurnState } from "../../packages/butler-agent/src/agent/turn/turn-kernel.ts";
import { TURN_CONTRACT_DECISION_SCHEMA } from "../../packages/butler-agent/src/agent/turn/turn-contract.ts";

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "butler-turn-kernel-context-"));
}

test("turn context atom persists, reads, and clears", () => {
  const butlerData = tempWorkspace();
  try {
    const sessionId = "butler/main/context-read";
    const turnId = "turn-context-read";
    persistTurnContextAtom({
      butlerData,
      sessionId,
      turnId,
      state: "continuing",
      sourceErrorCode: "prompt_usage_model_call_budget_exhausted",
      reason: "internal scheduler rollover",
      unresolvedObservations: [{ kind: "tool_result", id: "obs-1" }],
    });
    const persistedPath = join(
      butlerData,
      "state",
      "turn-kernel",
      createTurnContextAtomId(sessionId, turnId),
    );
    expect(existsSync(persistedPath)).toBe(true);
    const persisted = readTurnContextAtom({ butlerData, sessionId, turnId });
    expect(persisted).not.toBeNull();
    expect(persisted).toMatchObject({
      sessionId,
      turnId,
      state: "continuing",
      sourceErrorCode: "prompt_usage_model_call_budget_exhausted",
      reason: "internal scheduler rollover",
      userRequest: { id: `turn:${turnId}` },
      unresolvedObservations: [{ kind: "tool_result", id: "obs-1" }],
      evidenceCandidates: [],
      openToolPairs: [],
      currentTurnWork: [],
      currentTurnTodos: [],
    });
    clearTurnContextAtom({ butlerData, sessionId, turnId });
    expect(readTurnContextAtom({ butlerData, sessionId, turnId })).toBeNull();
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("turn context atom persists spec-minimum ref-only shape without raw request text", () => {
  const butlerData = tempWorkspace();
  try {
    const sessionId = "butler/main/context-redaction";
    const turnId = "turn-context-redaction";
    persistTurnContextAtom({
      butlerData,
      sessionId,
      turnId,
      state: "continuing",
      sourceErrorCode: "completion_gap_continuation",
      reason: "missing evidence",
      userRequest: {
        id: "message-1",
        text: "private raw request token=secret",
      },
      latestAssistantDecision: { id: "decision-1" },
      unresolvedObservations: [{ kind: "completion_gap", id: "observation-1" }],
      openToolPairs: [{ kind: "tool_pair", id: "tool-1" }],
      evidenceCandidates: [{
        kind: "source_candidate",
        id: "candidate-1:line-710",
        path: "packages/butler-agent/src/integrations/providers/provider.ts",
      }],
      latestCompletionReview: { status: "gap", observationId: "observation-1" },
      currentTurnWork: [{ kind: "work_stream", id: "work-1" }],
      currentTurnTodos: [{ kind: "todo", id: "todo-1" }],
      roundJournal: [{
        sequence: 1,
        decision_id: "decision-1",
        semantic_block_id: "contract-1:block:1",
        block_title: "Ledger 기준점 확인",
        tool: "project_ledger_status",
        ok: true,
        call_identity: "call-fingerprint",
        result_fingerprint: "result-fingerprint",
        state_revision: "state-revision",
        observed_delta: "none",
        result_preview: { ok: true, issueCount: 0 },
      }],
      budgetSnapshot: {
        turnId,
        modelRequestsUsed: 7,
        promptTokens: 1200,
        cachedTokens: 900,
        outputTokens: 80,
        totalTokens: 1280,
        maxModelCalls: 32,
        maxPromptTokens: 220000,
        maxOutputTokens: 80000,
        maxTotalTokens: 300000,
      },
    });
    const persisted = readTurnContextAtom({ butlerData, sessionId, turnId });

    expect(persisted).toMatchObject({
      userRequest: { id: "message-1" },
      latestAssistantDecision: { id: "decision-1" },
      unresolvedObservations: [{ kind: "completion_gap", id: "observation-1" }],
      openToolPairs: [{ kind: "tool_pair", id: "tool-1" }],
      evidenceCandidates: [{
        kind: "source_candidate",
        id: "candidate-1:line-710",
        path: "packages/butler-agent/src/integrations/providers/provider.ts",
      }],
      latestCompletionReview: { status: "gap", observationId: "observation-1" },
      currentTurnWork: [{ kind: "work_stream", id: "work-1" }],
      currentTurnTodos: [{ kind: "todo", id: "todo-1" }],
      roundJournal: [{
        sequence: 1,
        decision_id: "decision-1",
        block_title: "Ledger 기준점 확인",
        tool: "project_ledger_status",
        observed_delta: "none",
      }],
      budgetSnapshot: {
        turnId,
        modelRequestsUsed: 7,
        promptTokens: 1200,
        cachedTokens: 900,
        outputTokens: 80,
        totalTokens: 1280,
      },
    });
    expect(JSON.stringify(persisted)).not.toContain("private raw request");
    expect(JSON.stringify(persisted)).not.toContain("token=secret");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("turn context atom is not persisted for terminal states", () => {
  const butlerData = tempWorkspace();
  try {
    const sessionId = "butler/main/context-terminal";
    const turnId = "turn-context-terminal";
    persistTurnContextAtom({
      butlerData,
      sessionId,
      turnId,
      state: "completed",
      sourceErrorCode: "noop",
      reason: "completed already",
    });
    const persistedPath = join(
      butlerData,
      "state",
      "turn-kernel",
      createTurnContextAtomId(sessionId, turnId),
    );
    expect(existsSync(persistedPath)).toBe(false);
    expect(readTurnContextAtom({ butlerData, sessionId, turnId })).toBeNull();
    expect(isTerminalTurnState("completed")).toBe(true);
    expect(isTerminalTurnState("waiting_user")).toBe(true);
    expect(isTerminalTurnState("failed")).toBe(true);
    expect(isTerminalTurnState("runtime_fault")).toBe(true);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("turn context checkpoint uses generation CAS and preserves the round journal", () => {
  const butlerData = tempWorkspace();
  try {
    const sessionId = "butler/main/context-cas";
    const turnId = "turn-context-cas";
    const base = {
      butlerData,
      sessionId,
      turnId,
      state: "continuing" as const,
      sourceErrorCode: "prompt_usage_model_call_budget_exhausted",
      reason: "safety window exhausted",
      contractId: "contract-cas",
      workStreamId: "work-cas",
      todoListId: "todo-cas",
      nextSemanticBlockSequence: 2,
      turnDecision: {
        schema_version: TURN_CONTRACT_DECISION_SCHEMA,
        decision_id: "decision-cas",
        action: "resume_work" as const,
        target_workstream_id: "work-cas",
        deliverables: ["code_change" as const],
        public_summary: "기존 작업을 이어갑니다.",
      },
    };
    persistTurnContextAtom({
      ...base,
      roundJournal: [journalEntry("call-1", "result-1")],
    });
    const first = readTurnContextAtom({ butlerData, sessionId, turnId });
    expect(first).toMatchObject({
      schemaVersion: "butler.turn-continuation.v2",
      generation: 1,
      checkpointId: expect.stringContaining(":g1"),
      contractId: "contract-cas",
      workStreamId: "work-cas",
      todoListId: "todo-cas",
      nextSemanticBlockSequence: 2,
    });
    expect(() => persistTurnContextAtom({
      ...base,
      roundJournal: [journalEntry("call-conflict", "result-conflict")],
    })).toThrow("turn_continuation_generation_conflict");

    persistTurnContextAtom({
      ...base,
      expectedGeneration: 1,
      nextSemanticBlockSequence: 3,
      roundJournal: [journalEntry("call-2", "result-2")],
    });
    const second = readTurnContextAtom({ butlerData, sessionId, turnId });
    expect(second).toMatchObject({
      generation: 2,
      checkpointId: expect.stringContaining(":g2"),
      nextSemanticBlockSequence: 3,
      roundJournal: [
        { sequence: 1, call_identity: "call-1" },
        { sequence: 2, call_identity: "call-2" },
      ],
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

function journalEntry(callIdentity: string, resultFingerprint: string) {
  return {
    sequence: 1,
    tool: "read_file",
    ok: true,
    call_identity: callIdentity,
    result_fingerprint: resultFingerprint,
    state_revision: resultFingerprint,
    observed_delta: "evidence" as const,
  };
}
