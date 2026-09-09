import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBtccSqliteStores } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { createSubsessionDelegationService, type DelegationPacket, type SessionRelation } from "../../packages/butler-agent/src/agent/btcc/subsessions/index.ts";
import { createTurnRuntime, type BtccRunCommand } from "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import { admitTurn } from "../../packages/butler-agent/src/agent/btcc/turn/admission/index.ts";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { NativeInboundQueue } from "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import { FileQueueButlerServiceClient } from "../../packages/butler-agent/src/gateways/core/client.ts";
import { createBtccGatewayHandlers } from "../../packages/butler-agent/src/interfaces/gateway/btcc/create-btcc-gateway-handlers.ts";
import { handleStewardControlRoutes } from "../../packages/butler-agent/src/gateways/app/interface/server/routes/steward-control-routes.ts";
import type { AppRouteContext } from "../../packages/butler-agent/src/gateways/app/interface/server/server-types.ts";
import { createSubsessionToolHandlers } from "../../packages/butler-agent/src/agent/tools/subsession/executor.ts";

test.each(["app", "model"])("%s cancellation settles a waiting Steward and its admitted Worker through the queue", async (entry) => {
  const root = mkdtempSync(join(tmpdir(), "waiting-delegation-cancel-"));
  const stores = openBtccSqliteStores({ dbPath: join(root, "btcc.sqlite"), ownerId: "cancel-test", storageProfile: "ephemeral" });
  const bindings = new SessionBindingStore(join(root, "bindings.sqlite"), "ephemeral");
  const conversations = new AgentConversationStore({ butlerData: root, dbPath: join(root, "conversation.sqlite") });
  const delivered: string[] = [];
  try {
    for (const [sessionId, role] of [["butler/app-parent", "butler"], ["steward", "steward"], ["worker", "worker"]] as const) {
      bindings.upsert({ sessionId, role, workspacePath: root, runtimeAdapterId: "btcc-turn-runtime",
        modelProviderId: "openai", modelRef: "openai/gpt-5.5", metadata: { reasoning_effort: "low" },
        transportBindings: [{ transport: "app", accountId: "local", peerId: sessionId }] });
    }
    let markWorkerStarted!: () => void;
    const workerStarted = new Promise<void>((resolve) => { markWorkerStarted = resolve; });
    const runtime = createTurnRuntime({
      admission: stores.admission, turns: stores.turns, messages: stores.messages,
      committedSuccessorReadiness: stores.committedSuccessorReadiness,
      agent: { async run({ turn, signal }) {
        if (turn.sessionId === "worker") {
          markWorkerStarted();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return { content: "", route: "managed" };
        }
        return { content: "", route: "managed", executionOutcome: "waiting_for_worker" };
      } },
    });
    const stewardCommand = command(root, "steward", "steward-turn", "steward");
    await admitTurn(stewardCommand, stores.admission, stores.turns);
    const stewardWork = await stores.durableWork.startWork({ sessionId: "steward", turnId: "steward-turn", mutationCallId: "steward-work", objective: "unfinished parent work" });
    await runtime.runTurn(stewardCommand);
    const continuation = command(root, "steward", "steward-continuation", "steward");
    await admitTurn(continuation, stores.admission, stores.turns);
    await stores.durableWork.bindOpenWork({ sessionId: "steward", turnId: continuation.turnId }, stewardWork.workId);
    await runtime.runTurn(continuation);
    await admitTurn(command(root, "worker", "worker-turn", "worker"), stores.admission, stores.turns);
    const microWork = await stores.durableWork.startWork({ sessionId: "worker", turnId: "worker-turn", mutationCallId: "micro-work", objective: "unfinished micro work" });
    const workerExecution = runtime.runTurn(command(root, "worker", "worker-turn", "worker"));
    await workerStarted;
    const parentRelation = relation("parent-relation", "butler/app-parent", "parent-turn", "steward");
    const childRelation = relation("worker-relation", "steward", "steward-turn", "worker");
    for (const [owned, turnId, workId] of [[parentRelation, "steward-turn", stewardWork.workId], [childRelation, "worker-turn", microWork.workId]] as const) {
      stores.subsessionStore.create({ relation: owned, packet: packet(owned), childTurnId: turnId, rootWorkId: workId });
    }
    const service = createSubsessionDelegationService({
      butlerData: root, sessionBindings: bindings, store: stores.subsessionStore,
      durableWork: stores.durableWork, toolJournal: stores.guidedToolJournal,
      effectJournal: stores.guidedEffectJournal, parentTurns: stores.turns,
      contextDocuments: stores.contextDocuments, conversations,
      parentInputSink: async (input) => { delivered.push(input.text); },
    });
    if (entry === "app") {
      const url = new URL("http://localhost/steward-relations/parent-relation/cancel");
      const response = await handleStewardControlRoutes({
        url, request: new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parent_session_id: "parent" }) }),
        stewardObserver: stores.stewardObserver,
        serviceClient: new FileQueueButlerServiceClient({ butlerData: root }),
      } as unknown as AppRouteContext);
      expect(response?.status).toBe(202);
    } else {
      const tools = createSubsessionToolHandlers({ service, parentSessionId: "butler/app-parent", parentTurnId: "cancel-turn", anchorMessageId: "cancel-message" });
      expect(await tools.cancel_steward!({ name: "cancel_steward", args: {}, rawArguments: "{}" })).toMatchObject({ ok: true, status: "cancelling" });
    }
    const queue = new NativeInboundQueue(root);
    const queued = queue.claimEligible(1, () => true)[0]!;
    expect(queued.envelope.control?.turnId).toBe("steward-continuation");
    const handlers = createBtccGatewayHandlers({
      btcc: { runTurn: async () => { throw new Error("Cancellation must not run a model"); }, stopTurn: ({ turnId }) => runtime.stopTurn({ kind: "stop", turnId }) },
      subsessionDelegation: service,
    });
    const acknowledgement = await handlers.steward!({ route: { sessionId: "steward", role: "steward", reason: "session-hint", workspacePath: root }, envelope: queued.envelope });
    expect(acknowledgement).toMatchObject({ ok: true, metadata: { kind: "turn_cancelled" } });
    expect((await workerExecution).kind).toBe("cancelled");
    expect((await stores.turns.findTurn("worker-turn"))?.semanticState).toBe("cancelled");
    expect(stores.subsessionStore.resultByRelationId("parent-relation")?.status).toBe("cancelled");
    expect(stores.subsessionStore.resultByRelationId("worker-relation")?.status).toBe("cancelled");
    expect((await stores.durableWork.boundWorkForTurn("steward-turn"))?.status).toBe("abandoned");
    expect((await stores.durableWork.boundWorkForTurn("worker-turn"))?.status).toBe("abandoned");
    expect(await service.shouldWaitForWorker({ parentSessionId: "steward", parentTurnId: "steward-turn" })).toBe(false);
    expect(delivered).toHaveLength(1);
    expect(queue.claimEligible(10, () => true)).toHaveLength(0);
  } finally {
    stores.close();
    conversations.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function relation(id: string, parent: string, turn: string, child: string): SessionRelation {
  return { relation_id: id, parent_session_id: parent, parent_turn_id: turn, child_session_id: child,
    anchor_message_id: `${id}-anchor`, ordinal: 1, safe_title: "Bounded task", created_at: "2026-09-03T00:00:00.000Z" };
}

function packet(owned: SessionRelation): DelegationPacket {
  return { relation_id: owned.relation_id, delegation_id: `${owned.relation_id}-delegation`, task_id: `${owned.relation_id}-task`,
    parent_session_id: owned.parent_session_id, parent_turn_id: owned.parent_turn_id,
    execution_mode: "mutation", objective: "Complete the bounded assignment", acceptance_criteria: [], task_or_plan_refs: [],
    constraints_and_non_goals: [], allowed_tools_and_effects: [], mutation_scope: [],
    workspace_and_worktree: { ownership: "parent_session", workspace_label: "Inherited parent session workspace", repository_anchor_ref: "parent-session-workspace" },
    expected_result_schema: { version: 1, status: "success", required_fields: ["summary", "acceptance_evidence", "changed_artifacts"] },
    work_creation_policy: "one_recoverable_child_work",
    access_and_budget_policy: { access_mode: "full_access", max_turns: 8, model_ref: "openai/gpt-5.5", reasoning_effort: "low" },
    parent_work_ref: { work_id: "parent-work", session_id: owned.parent_session_id, turn_id: owned.parent_turn_id, plan_revision_id: "plan", review_revision_id: "review" },
    model_ref: "openai/gpt-5.5", reasoning_effort: "low" };
}

function command(root: string, sessionId: string, turnId: string, role: "steward" | "worker"): Extract<BtccRunCommand, { kind: "run" }> {
  return { kind: "run", turnId, sessionId, triggerKey: `message:${turnId}`,
    message: { messageId: `message:${turnId}`, content: "Bounded task" },
    modelSelection: { provider: "openai", model: "gpt-5.5", reasoningEffort: "low", controls: { accessMode: "full_access" }, controlsHash: "controls" },
    context: { userRef: "local-user", profileRefs: [], recentFeedbackRefs: [], mandatoryHotCacheRefs: [], optionalHotCacheRefs: [], baselineObservationScopeRefs: [],
      executionPolicy: { role, accessMode: "full_access", trackingMode: "local", requiredNativeToolProfiles: [], requiredNativeTools: [], workspacePath: root } } };
}
