import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeInboundQueue } from "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import { createGuidedTurnCloseout } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-closeout.ts";
import { runGuidedAgentLoopWithOperationalReport } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-operational-report.ts";
import { completeWorkerResultForDependencies } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/worker-result.ts";
import { completeStewardResultForDependencies } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/terminal-result-service.ts";
import { resolveParentResultEvidence } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/accepted-terminal-report.ts";
import { subsessionResultId } from "../../packages/butler-agent/src/agent/btcc/subsessions/identities.ts";
import { renderParentResult } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/subsession-result-record.ts";
import { dispositionMaterialFingerprint, type DurableWorkService, type DurableWorkView } from
  "../../packages/butler-agent/src/agent/btcc/work/index.ts";
import { DURABLE_WORK_TOOL_DEFINITIONS } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/durable-work-tool-definitions.ts";
import type { GuidedToolJournalRecord } from "../../packages/butler-agent/src/agent/btcc/ports/index.ts";
import type {
  StewardResultEnvelope, SubsessionDelegationDependencies,
} from "../../packages/butler-agent/src/agent/btcc/subsessions/contracts.ts";
import type { ModelRoundRequest, ModelRoundResult } from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";

const QUESTION = "Which database should the service use: PostgreSQL or SQLite?";
const dispositionTool = DURABLE_WORK_TOOL_DEFINITIONS.find((tool) => tool.name === "record_work_disposition")!;

function blockCall(workId: string) {
  const args = { work_id: workId, disposition: "blocked", blocked_code: "needs_user_decision",
    summary: "Only the user can choose the database.", next_condition: QUESTION };
  return { id: "block", name: "record_work_disposition", arguments: args, rawArguments: JSON.stringify(args) };
}

/** One child role: a bounded scripted model blocks for a user decision through the real loop and closeout. */
async function runChildThatNeedsUserDecision(role: "worker" | "steward", prompt: string) {
  const turnId = `${role}-turn`;
  const journal: GuidedToolJournalRecord[] = [];
  let work = { workId: `${role}-work`, sessionId: `${role}-session`, status: "open", currentStage: "execution",
    actionProgress: [], resultRefs: [] } as unknown as DurableWorkView;
  const durableWork = {
    boundWorkForTurn: async () => work,
    loadContext: async () => ({ work }),
    claimCloseoutCorrection: async () => true,
  } as unknown as DurableWorkService;
  const closeout = createGuidedTurnCloseout({ durableWork, workScope: { turnId, sessionId: `${role}-session` }, turnId,
    trackingMode: "local", responseLanguage: "English", originalRequest: prompt, requiresTerminalResult: true,
    toolJournal: { list: () => journal } });
  const requests: ModelRoundRequest[] = [];
  const steps: ModelRoundResult[] = [
    { toolCalls: [blockCall(work.workId)] },
    { text: `Blocked until the user decides. ${QUESTION}`, toolCalls: [] },
  ];
  const text = await runGuidedAgentLoopWithOperationalReport({
    options: {
      prompt, tools: [dispositionTool],
      modelRound: { async runRound(request) {
        requests.push(request);
        const step = steps[requests.length - 1];
        if (!step) throw new Error(`scripted ${role} exceeded ${steps.length} rounds: ${JSON.stringify(request.messages.at(-1))}`);
        return step;
      } },
      executeTool: async (call) => {
        journal.push({ callId: call.id, toolName: call.name, rawArguments: call.rawArguments,
          arguments: call.arguments, status: "completed" });
        const blocked = { ...work, status: "blocked" } as DurableWorkView;
        work = { ...blocked, latestDisposition: { disposition: "blocked", originTurnId: turnId,
          summary: String(call.arguments.summary), nextCondition: String(call.arguments.next_condition),
          remainingActions: [], runtimeOwnedOpen: false, materialFingerprint: dispositionMaterialFingerprint(blocked) },
        } as unknown as DurableWorkView;
        return { ok: true };
      },
      reviewFinalCandidate: closeout.reviewFinalCandidate,
    },
    parentSignal: new AbortController().signal, originalRequest: prompt,
    loadFacts: async () => ({ work: null, toolCalls: [], effects: [] }),
  });
  expect(typeof text).toBe("string");
  return { text: await closeout.reconcileAfterLoop(text as string), result: (await closeout.acceptedWorkResult())!, requests };
}

function resultDependencies(root: string, childSession: string, committed: StewardResultEnvelope[]) {
  const relation = { relation_id: `relation-${"a".repeat(40)}`, parent_session_id: "parent", parent_turn_id: "parent-turn",
    child_session_id: childSession, anchor_message_id: "anchor", ordinal: 1, safe_title: "Child", created_at: "2026-09-25T00:00:00Z" };
  return {
    butlerData: root,
    store: {
      relationByChildSessionId: () => relation, relationById: () => relation,
      childTurnIdByRelationId: () => `${childSession.split("-")[0]}-turn`,
      rootWorkIdByRelationId: () => `${childSession.split("-")[0]}-work`,
      taskIdByRelationId: () => "task", latestDirection: () => null,
      packetByRelationId: () => ({ task_id: "task", model_ref: "openai/test", reasoning_effort: "medium",
        parent_work_ref: { work_id: "parent-work" } }),
      resultByRelationId: () => committed.at(-1) ?? null,
      relationsByParentSessionId: () => [relation],
      pendingParentInputForResult: () => null,
      commitResult: (input: Record<string, unknown>) => {
        const envelope = { result_id: input.resultId, relation_id: relation.relation_id, task_id: "task",
          child_session_id: childSession, child_turn_id: input.childTurnId, status: input.status, code: input.code,
          summary: input.summary, acceptance_evidence: input.acceptanceEvidence, changed_artifacts: [], commits: [],
          tests: [], remaining_risks: [], follow_up_recommendations: [], detail_refs: [],
          created_at: "2026-09-25T00:00:00Z" } as unknown as StewardResultEnvelope;
        committed.push(envelope);
        return { inserted: true, result: envelope, parentInput: { text: renderParentResult(envelope) } };
      },
      markParentInputDelivered: () => {},
    },
    parentTurns: { findTurn: async (turnId: string) => ({ turnId, sessionId: childSession, semanticState: "delivered" }) },
    durableWork: { boundWorkForTurn: async () => ({ workId: `${childSession.split("-")[0]}-work`, sessionId: childSession }) },
    sessionBindings: { getBySessionId: () => ({ role: "steward", workspacePath: root, modelRef: "openai/test",
      metadata: { reasoning_effort: "medium" }, transportBindings: [{ transport: "app", peerId: "parent-chat" }] }) },
  } as unknown as SubsessionDelegationDependencies;
}

test("a Worker needs_user_decision reaches Butler as a question, never a runtime failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-user-decision-"));
  try {
    // Worker blocks for a user decision; its code and evidence become the Steward's input.
    const worker = await runChildThatNeedsUserDecision("worker", "Configure storage for the service.");
    expect(worker.result).toMatchObject({ status: "blocked", code: "needs_user_decision" });
    const workerResults: StewardResultEnvelope[] = [];
    await completeWorkerResultForDependencies(resultDependencies(root, "worker-session", workerResults),
      new NativeInboundQueue(root), {
        childSessionId: "worker-session", childTurnId: "worker-turn",
        resultId: subsessionResultId("worker-session", "worker-turn"), summary: worker.text,
        status: worker.result.status as "blocked", code: "needs_user_decision", acceptanceEvidence: worker.result.evidence,
      });
    const stewardInput = renderParentResult(workerResults[0]!);
    expect(stewardInput).toContain("Code: needs_user_decision");
    expect(stewardInput).toContain(QUESTION);

    // Steward relays the same blocked code upward instead of guessing.
    const steward = await runChildThatNeedsUserDecision("steward", stewardInput);
    expect(steward.result).toMatchObject({ status: "blocked", code: "needs_user_decision" });
    const stewardResults: StewardResultEnvelope[] = [];
    await completeStewardResultForDependencies(resultDependencies(root, "steward-session", stewardResults), async () => {}, {
      childSessionId: "steward-session", childTurnId: "steward-turn",
      resultId: subsessionResultId("steward-session", "steward-turn"), summary: steward.text,
      status: "blocked", code: "needs_user_decision", acceptanceEvidence: steward.result.evidence,
    });

    // Butler's result synthesis tells it to ask; its reply carries the question.
    const deps = resultDependencies(root, "steward-session", stewardResults);
    const evidence = await resolveParentResultEvidence({ parentSessionId: "parent",
      parentInputText: renderParentResult(stewardResults[0]!), store: deps.store, turns: deps.parentTurns });
    expect(evidence?.synthesisEvidence).toContain("Ask the user the specific question");
    let butlerRounds = 0;
    const reply = await runGuidedAgentLoopWithOperationalReport({
      options: { prompt: `Continue.\n\n${evidence!.synthesisEvidence}`, tools: [], executeTool: async () => ({}),
        modelRound: { async runRound(request) {
          if (++butlerRounds > 1) throw new Error("scripted Butler exceeded 1 round");
          expect(request.messages[0]!.content).toContain(QUESTION);
          return { text: `Before I continue, I need your decision. ${QUESTION}`, toolCalls: [] };
        } } },
      parentSignal: new AbortController().signal, originalRequest: "Configure storage for the service.",
      loadFacts: async () => ({ work: null, toolCalls: [], effects: [] }),
    });
    expect(reply).toContain(QUESTION);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
