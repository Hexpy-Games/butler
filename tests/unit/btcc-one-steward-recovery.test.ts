/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAppServer } from "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";
import { NativeInboundQueue } from "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import { GatewayRouter } from "../../packages/butler-agent/src/gateways/core/router.ts";
import { createGatewayServer } from "../../packages/butler-agent/src/gateways/core/server.ts";
import { createProductionBtccComposition } from "../../packages/butler-agent/src/agent/composition/create-btcc-composition.ts";
import { createBtccGatewayHandlers } from "../../packages/butler-agent/src/interfaces/gateway/btcc/create-btcc-gateway-handlers.ts";
import { BtccInboundDispatcher } from "../../packages/butler-agent/src/interfaces/gateway/btcc/btcc-inbound-dispatcher.ts";
import { DeliveryGuard } from "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { createAppTransportAdapter } from "../../packages/butler-agent/src/interfaces/transport/app/adapter.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { sessionHintForRow } from "../../packages/butler-agent/src/gateways/app/domain/sessions/session-read-model.ts";
import type { ModelRoundPort, ModelRoundRequest } from "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { subsessionResultId } from "../../packages/butler-agent/src/agent/btcc/subsessions/index.ts";
import { recoverPendingParentInputs } from "../../packages/butler-agent/src/agent/btcc/subsessions/outbox-recovery.ts";
import type { SubsessionDelegationStore } from "../../packages/butler-agent/src/agent/btcc/subsessions/contracts.ts";
import { BTCC_SUBSESSION_SCHEMA } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema/subsession-schema.ts";
import { migrateSubsessionResultSchema } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema/subsession-schema-migration.ts";
import { SqliteGuidedWorkStore } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { SqlitePrincipalAuthorityRepository } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/authority-repository.ts";
import { createPrincipalAuthority } from
  "../../packages/butler-agent/src/agent/btcc/authority/index.ts";
import { createDurableWorkService } from "../../packages/butler-agent/src/agent/btcc/work/index.ts";
import type { ReviewedDelegationPlan } from "../../packages/butler-agent/src/agent/btcc/subsessions/index.ts";

const roots: string[] = [];
function recoveryStewardReport(receiptId: string): string {
  return [
  "Conclusion: the Steward mutation survived restart and was verified.",
  `Evidence: recovery-result.txt and ${receiptId} agree with the accepted Work.`,
  "Commits: none required.",
  "Tests: restart and busy-parent ordering passed.",
  "Remaining risks: provider deployment was outside this bounded proof.",
  "Follow-up recommendations: retain the canonical outbox replay path.",
  ].join("\n");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("one Steward result survives restart and waits behind a busy Butler turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-one-steward-recovery-"));
  roots.push(root);
  initializeGitWorkspace(root);
  publishNativeReadiness(root);
  const authToken = "ss02b-local-auth-token-012345678901234567890123";
  const bindingStorePath = join(root, "runtime", "session-store.sqlite");
  let bindings = new SessionBindingStore(bindingStorePath, "ephemeral");
  const parentSessionId = sessionHintForRow("general");
  bindings.upsert({
    sessionId: parentSessionId,
    role: "butler",
    workspacePath: root,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.5",
    transportBindings: [{ transport: "app", accountId: "local", peerId: "general" }],
  });
  const childRequests: ModelRoundRequest[] = [];
  const synthesisEvidence: string[] = [];
  const busyParentStarted = deferred<void>();
  const releaseBusyParent = deferred<void>();
  const childFinalStarted = deferred<void>();
  const releaseChildFinal = deferred<void>();
  const modelRound = recoveryRound({
    childRequests,
    synthesisEvidence,
    busyParentStarted,
    releaseBusyParent,
    childFinalStarted,
    releaseChildFinal,
  });
  let app = createAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerHome: root,
    butlerData: root,
    port: 0,
    localAuth: { required: true, token: authToken },
  });
  let composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "one-steward-recovery-test-a",
    sessionBindings: bindings,
    appServerUrl: app.url,
    appLocalAuth: { required: true, token: authToken },
    modelRound,
  });
  let queue = new NativeInboundQueue(root);
  let inbound = new BtccInboundDispatcher();
  let deliveryGuard = new DeliveryGuard({ adapters: [createAppTransportAdapter()], butlerData: root });
  const createGateway = () => createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({ btcc: composition.btcc, subsessionDelegation: composition.subsessions }),
    butlerData: root,
  });
  let gateway = createGateway();
  const first = await postMessage(app.url, authToken, "Delegate the bounded recovery task.", "client-recovery-first-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  expect(first.status).toBe(202);
  await pollAndWait(inbound, queue, gateway, bindings, deliveryGuard, 1);
  const beforeRestart = new Database(join(root, "agent-runtime", "btcc.sqlite"), { readonly: true });
  let persistedIdentity: {
    relation_id: string;
    child_session_id: string;
    task_id: string;
    root_work_id: string;
  };
  try {
    persistedIdentity = beforeRestart.query<typeof persistedIdentity, []>(`
      SELECT r.relation_id, r.child_session_id, d.task_id, d.root_work_id
      FROM btcc_session_relations r
      JOIN btcc_subsession_delegations d ON d.relation_id = r.relation_id
      LIMIT 1
    `).get()!;
    expect(persistedIdentity).toBeTruthy();
    expect(beforeRestart.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM btcc_guided_works WHERE session_id = ?
    `).get(persistedIdentity.child_session_id)?.count).toBe(0);
  } finally {
    beforeRestart.close();
  }
  app.stop();
  await composition.host.close();
  bindings.close();

  const legacyPacketDb = new Database(join(root, "agent-runtime", "btcc.sqlite"));
  try {
    const packetRow = legacyPacketDb.query<{ packet_json: string }, [string]>(`
      SELECT packet_json FROM btcc_subsession_delegations WHERE relation_id = ?
    `).get(persistedIdentity.relation_id);
    const legacyPacket = JSON.parse(packetRow?.packet_json ?? "{}") as Record<string, unknown>;
    delete legacyPacket.execution_mode;
    expect((legacyPacket.access_and_budget_policy as Record<string, unknown>).access_mode)
      .toBe("full_access");
    legacyPacketDb.query(`
      UPDATE btcc_subsession_delegations SET packet_json = ? WHERE relation_id = ?
    `).run(JSON.stringify(legacyPacket), persistedIdentity.relation_id);
  } finally {
    legacyPacketDb.close();
  }
  const legacyBindingDb = new Database(bindingStorePath);
  try {
    const bindingRow = legacyBindingDb.query<{ metadata_json: string }, [string]>(`
      SELECT metadata_json FROM session_bindings WHERE session_id = ?
    `).get(persistedIdentity.child_session_id);
    const metadata = JSON.parse(bindingRow?.metadata_json ?? "{}") as Record<string, unknown>;
    const subsession = metadata.subsession;
    if (!subsession || typeof subsession !== "object" || Array.isArray(subsession)) {
      throw new Error("legacy Steward subsession metadata missing");
    }
    delete (subsession as Record<string, unknown>).execution_mode;
    expect((subsession as Record<string, unknown>).execution_mode).toBeUndefined();
    legacyBindingDb.query(`
      UPDATE session_bindings SET metadata_json = ? WHERE session_id = ?
    `).run(JSON.stringify(metadata), persistedIdentity.child_session_id);
  } finally {
    legacyBindingDb.close();
  }

  app = createAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerHome: root,
    butlerData: root,
    port: 0,
    localAuth: { required: true, token: authToken },
  });
  bindings = new SessionBindingStore(bindingStorePath, "ephemeral");
  queue = new NativeInboundQueue(root);
  inbound = new BtccInboundDispatcher();
  deliveryGuard = new DeliveryGuard({ adapters: [createAppTransportAdapter()], butlerData: root });
  composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "one-steward-recovery-test-b",
    sessionBindings: bindings,
    appServerUrl: app.url,
    appLocalAuth: { required: true, token: authToken },
    modelRound,
  });
  gateway = createGateway();
  await composition.ready;
  await pollUntil(inbound, queue, gateway, bindings, deliveryGuard, () => childFinalStarted.promise);
  const second = await postMessage(app.url, authToken, "Continue while Steward runs.", "client-recovery-second-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  expect(second.status).toBe(202);
  await pollUntil(inbound, queue, gateway, bindings, deliveryGuard, () => busyParentStarted.promise);
  releaseChildFinal.resolve();
  const pendingResult = await waitForPendingResult(app, 1000);
  expect(pendingResult).toBe(1);
  releaseBusyParent.resolve();
  await inbound.waitForIdle();
  await drain(inbound, queue, gateway, bindings, deliveryGuard);

    const db = new Database(join(root, "agent-runtime", "btcc.sqlite"), { readonly: true });
    try {
      const resultSchema = db.query<{ sql: string }, []>(`
        SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'btcc_steward_results'
      `).get()?.sql ?? "";
      expect(resultSchema).toContain("'success', 'blocked', 'failed', 'cancelled'");
      expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM btcc_session_relations").get()?.count).toBe(1);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM btcc_subsession_delegations").get()?.count).toBe(1);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM btcc_steward_results").get()?.count).toBe(1);
    const durableResult = db.query<{
      status: string;
      summary: string;
      acceptance_evidence_json: string;
      changed_artifacts_json: string;
      commits_json: string;
      tests_json: string;
      remaining_risks_json: string;
      follow_up_recommendations_json: string;
      detail_refs_json: string;
    }, []>(`
      SELECT status, summary, acceptance_evidence_json, changed_artifacts_json,
        commits_json, tests_json, remaining_risks_json,
        follow_up_recommendations_json, detail_refs_json
      FROM btcc_steward_results
    `).get();
    expect(durableResult).toMatchObject({
      status: "success",
      summary: "the Steward mutation survived restart and was verified.",
      commits_json: "[]",
      tests_json: '["restart and busy-parent ordering passed."]',
      remaining_risks_json: '["provider deployment was outside this bounded proof."]',
      follow_up_recommendations_json: '["retain the canonical outbox replay path."]',
    });
    const detailRefs = JSON.parse(durableResult?.detail_refs_json ?? "[]") as string[];
    expect(detailRefs).toEqual([expect.stringMatching(/^btcc-final-payload:v1:/u)]);
    expect(JSON.parse(durableResult?.acceptance_evidence_json ?? "[]")).toEqual([]);
    expect(JSON.parse(durableResult?.changed_artifacts_json ?? "[]")).toEqual([]);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM btcc_subsession_outbox WHERE status = 'delivered'").get()?.count).toBe(1);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM btcc_guided_effects WHERE status = 'applied'").get()?.count).toBe(1);
    const identityAfterRestart = db.query<{
      relation_id: string;
      child_session_id: string;
      task_id: string;
      root_work_id: string;
    }, []>(`
      SELECT r.relation_id, r.child_session_id, d.task_id, d.root_work_id
      FROM btcc_session_relations r
      JOIN btcc_subsession_delegations d ON d.relation_id = r.relation_id
      LIMIT 1
    `).get();
    expect(identityAfterRestart).toEqual(persistedIdentity);
    const childSessionId = db.query<{ child_session_id: string }, []>(`
      SELECT child_session_id FROM btcc_session_relations LIMIT 1
    `).get()?.child_session_id;
    if (!childSessionId) throw new Error("Steward child session was not persisted");
    expect(db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM btcc_guided_works WHERE session_id = ?
    `).get(childSessionId)?.count).toBe(1);
    expect(db.query<{ work_id: string }, [string]>(`
      SELECT work_id FROM btcc_guided_works WHERE session_id = ? LIMIT 1
    `).get(childSessionId)?.work_id).toBe(identityAfterRestart?.root_work_id);
    expect(db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM btcc_turns WHERE session_id = ?").get(parentSessionId)?.count).toBe(3);
    const newest = db.query<{ content: string }, [string]>(`
      SELECT content FROM btcc_messages WHERE session_id = ?
      ORDER BY created_at DESC, message_id DESC LIMIT 1
    `).get(parentSessionId);
    expect(newest?.content).toBe("Steward result synthesized after busy parent.");
    const parentMessageCountBeforeReplay = db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM btcc_messages WHERE session_id = ?
    `).get(parentSessionId)?.count;
    const appMessagesResponse = await fetch(`${app.url}messages?chat_id=general`, {
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(appMessagesResponse.status).toBe(200);
    const appMessagesBody = await appMessagesResponse.json() as {
      data: { messages: Array<{ role: string; text: string }> };
    };
    const assistantMessages = appMessagesBody.data.messages.filter((message) => message.role === "assistant");
    expect(assistantMessages.slice(-2).map((message) => message.text)).toEqual([
      "Second Butler response.",
      "Steward result synthesized after busy parent.",
    ]);
      const inputJson = db.query<{ input_json: string }, []>(`
        SELECT input_json FROM btcc_subsession_outbox LIMIT 1
      `).get()?.input_json;
      if (!inputJson) throw new Error("Steward outbox input was not persisted");
      expect(inputJson).toContain(detailRefs[0]!);
      expect(inputJson).not.toContain("agree with the accepted Work");
      expect(inputJson).not.toMatch(
        /workspace_and_worktree|mutation_scope|allowed_tools_and_effects|delegation_id:/u,
      );
      expect(synthesisEvidence).toEqual([expect.stringContaining(detailRefs[0]!) ]);
      expect(synthesisEvidence[0]).toContain(
        "the Steward mutation survived restart and was verified",
      );
      const replay = await fetch(`${app.url}internal/subsession-result`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
        body: inputJson,
      });
      expect(replay.status).toBe(202);
      await drain(inbound, queue, gateway, bindings, deliveryGuard);
      expect(db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_steward_results",
      ).get()?.count).toBe(1);
      expect(app.store.db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM session_queued_messages WHERE chat_id = 'general'
      `).get()?.count).toBe(3);
      expect(db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM btcc_turns WHERE session_id = ?
      `).get(parentSessionId)?.count).toBe(3);
      expect(db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM btcc_messages WHERE session_id = ?
      `).get(parentSessionId)?.count).toBe(parentMessageCountBeforeReplay);
    } finally {
    db.close();
    app.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

test("typed Steward terminal results share the outbox and incomplete context blocks before Work", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-one-steward-terminal-"));
  roots.push(root);
  initializeGitWorkspace(root);
  publishNativeReadiness(root);
  const authToken = "ss02b-terminal-auth-token-012345678901234567890123";
  const bindings = new SessionBindingStore(join(root, "runtime", "session-store.sqlite"), "ephemeral");
  const app = createAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerHome: root,
    butlerData: root,
    port: 0,
    localAuth: { required: true, token: authToken },
  });
  let blockedRound = 0;
  let blockedDispositionCalls = 0;
  const parentCases = [
    { key: "blocked", status: "blocked" as const, accessMode: "full_access" as const },
    { key: "cancelled-read-only", status: "cancelled" as const,
      code: "steward_cancelled" as const, accessMode: "read_only" as const },
    { key: "cancelled-ask-first", status: "cancelled" as const,
      code: "steward_cancelled" as const, accessMode: "ask_first" as const },
  ];
  const incompleteParentSessionId = sessionHintForRow("general");
  bindings.upsert({
    sessionId: incompleteParentSessionId,
    role: "butler",
    workspacePath: root,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.5",
    transportBindings: [{ transport: "app", accountId: "local", peerId: "general" }],
  });
  const composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "one-steward-terminal-test",
    sessionBindings: bindings,
    appServerUrl: app.url,
    appLocalAuth: { required: true, token: authToken },
    modelRound: { async runRound(request) {
      const requestBody = request.messages.map((message) => message.content).join("\n");
      const isSynthesis = requestBody.includes("Canonical child result synthesis") ||
        requestBody.includes("Subsession result");
      const synthesisStatus = requestBody.match(/Status: (blocked|failed|cancelled)/u)?.[1];
      if (isSynthesis && synthesisStatus) {
        return { text: `Terminal synthesis ${synthesisStatus}.`, toolCalls: [] };
      }
      if (requestBody.includes("blocked terminal result test") &&
        request.tools.some((tool) => tool.name === "record_work_disposition")) {
        blockedRound += 1;
        if (blockedRound === 1) {
          return { toolCalls: [toolCall("blocked-plan", "replace_work_plan", {
            objective: "Apply the verified partial file before the external input blocks completion.",
            actions: [{
              action_key: "write-partial-file",
              description: "Write the verified partial artifact.",
              dependency_keys: [],
              effect: { capability: "write_file", target: "terminal-result.txt" },
            }, {
              action_key: "await-required-input",
              description: "Finish after the required external input is available.",
              dependency_keys: ["write-partial-file"],
            }],
            checks: ["The partial artifact is preserved if completion blocks"],
          })] };
        }
        if (blockedRound === 2) {
          return { toolCalls: [toolCall("blocked-plan-review", "record_work_review", {
            subject: "plan",
            verdict: "accept",
            summary: "The partial mutation is bounded before the external dependency.",
          })] };
        }
        if (blockedRound === 3) {
          return { toolCalls: [toolCall("blocked-write", "write_file", {
            path: "terminal-result.txt",
            content: "verified partial change\n",
          })] };
        }
        if (blockedRound > 4) {
          return { text: "Blocked Steward terminal report.", toolCalls: [] };
        }
        const workId = [...requestBody.matchAll(/guided-work-[a-f0-9]{64}/gu)]
          .map((match) => match[0]).at(-1);
        if (!workId) throw new Error("blocked Steward Work id was not projected to the model");
        blockedDispositionCalls += 1;
        return { toolCalls: [toolCall("blocked", "record_work_disposition", {
          work_id: workId,
          disposition: "blocked",
          summary: "The bounded Steward task is blocked after one verified partial change.",
          next_condition: "The required bounded input is unavailable.",
          action_updates: [
            { action_key: "write-partial-file", status: "done" },
            { action_key: "await-required-input", status: "blocked" },
          ],
        })] };
      }
      return { text: "Unexpected terminal round.", toolCalls: [] };
    } },
  });
  const queue = new NativeInboundQueue(root);
  const inbound = new BtccInboundDispatcher();
  const gateway = createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({
      btcc: composition.btcc,
      subsessionDelegation: composition.subsessions,
    }),
    butlerData: root,
  });
  const deliveryGuard = new DeliveryGuard({
    adapters: [createAppTransportAdapter()],
    butlerData: root,
  });
  try {
    for (const parentCase of parentCases) {
      const parentSessionId = sessionHintForRow("general");
      const parentTurnId = `terminal-parent-turn-${parentCase.key}`;
      const reviewed = await installReviewedDelegationPlan({
        dbPath: join(root, "agent-runtime", "btcc.sqlite"),
        sessionId: parentSessionId,
        turnId: parentTurnId,
        objective: parentCase.key === "blocked"
          ? "Perform one blocked terminal result test."
          : "Perform one bounded terminal result test.",
        ...(parentCase.key === "cancelled-read-only"
          ? {}
          : { check: "The typed terminal result is persisted safely." }),
        accessMode: parentCase.accessMode,
      });
      if (parentCase.accessMode !== "full_access") {
        await expect(composition.subsessions.delegate({
          parent_session_id: parentSessionId,
          parent_turn_id: parentTurnId,
          anchor_message_id: `terminal-anchor-${parentCase.key}`,
          parent_access_mode: "full_access",
          execution_mode: "read_only",
          safe_title: `Forged terminal ${parentCase.key}`,
          objective: reviewed.objective,
          acceptance_criteria: reviewed.acceptance_criteria,
          task_or_plan_refs: reviewed.task_or_plan_refs,
          constraints_and_non_goals: [],
          allowed_tools_and_effects: [
            "grep_files:workspace", "list_files:workspace", "read_file:workspace",
            "web_read:network", "web_search:network",
          ],
          mutation_scope: [],
          parent_work_ref: reviewed.parent_work_ref,
          model_ref: "openai/gpt-5.5",
          reasoning_effort: "low",
        })).rejects.toThrow("subsession_parent_access_mode_mismatch");
      }
      const created = await composition.subsessions.delegate({
        parent_session_id: parentSessionId,
        parent_turn_id: parentTurnId,
        anchor_message_id: `terminal-anchor-${parentCase.key}`,
        parent_access_mode: parentCase.accessMode,
        execution_mode: parentCase.accessMode === "read_only" ? "read_only" : "mutation",
        safe_title: `Terminal ${parentCase.key}`,
        objective: reviewed.objective,
        acceptance_criteria: reviewed.acceptance_criteria,
        task_or_plan_refs: reviewed.task_or_plan_refs,
        constraints_and_non_goals: [],
        allowed_tools_and_effects: parentCase.accessMode === "read_only"
          ? [
              "grep_files:workspace", "list_files:workspace", "read_file:workspace",
              "web_read:network", "web_search:network",
            ]
          : ["write_file:workspace"],
        mutation_scope: parentCase.accessMode === "read_only" ? [] : ["terminal-result.txt"],
        parent_work_ref: reviewed.parent_work_ref,
        model_ref: "openai/gpt-5.5",
        reasoning_effort: "low",
      });
      if (parentCase.key === "cancelled-read-only") {
        const packetDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), {
          readonly: true,
        });
        try {
          const packetJson = packetDb.query<{ packet_json: string }, [string]>(`
            SELECT packet_json FROM btcc_subsession_delegations WHERE relation_id = ?
          `).get(created.relation.relation_id)?.packet_json;
          expect(JSON.parse(packetJson ?? "{}")).toMatchObject({
            parent_work_ref: reviewed.parent_work_ref,
            acceptance_criteria: [],
          });
        } finally {
          packetDb.close();
        }
      }
      if (parentCase.status === "cancelled") {
        const result = await composition.subsessions.completeStewardResult({
          childSessionId: created.relation.child_session_id,
          childTurnId: created.child_turn_id,
          resultId: subsessionResultId(created.relation.child_session_id, created.child_turn_id),
          status: parentCase.status,
          ...(parentCase.code ? { code: parentCase.code } : {}),
        });
        expect(result.status).toBe("committed");
        expect(result.result).toMatchObject({ status: parentCase.status, code: parentCase.code ?? null });
      } else {
        await drain(inbound, queue, gateway, bindings, deliveryGuard);
      }
    }

    const incompleteReviewed = await installReviewedDelegationPlan({
      dbPath: join(root, "agent-runtime", "btcc.sqlite"),
      sessionId: incompleteParentSessionId,
      turnId: "terminal-parent-turn-incomplete",
      objective: "This objective will be removed before Steward admission.",
      check: "The missing packet context is blocked safely.",
    });
    const incompleteCreated = await composition.subsessions.delegate({
      parent_session_id: incompleteParentSessionId,
      parent_turn_id: "terminal-parent-turn-incomplete",
      anchor_message_id: "terminal-anchor-incomplete",
      parent_access_mode: "full_access",
      execution_mode: "mutation",
      safe_title: "Terminal incomplete context",
      objective: incompleteReviewed.objective,
      acceptance_criteria: incompleteReviewed.acceptance_criteria,
      task_or_plan_refs: incompleteReviewed.task_or_plan_refs,
      constraints_and_non_goals: [],
      allowed_tools_and_effects: ["write_file:workspace"],
      mutation_scope: ["terminal-incomplete.txt"],
      parent_work_ref: incompleteReviewed.parent_work_ref,
      model_ref: "openai/gpt-5.5",
      reasoning_effort: "low",
    });
    const agentDb = new Database(join(root, "agent-runtime", "btcc.sqlite"));
    try {
      const packetRow = agentDb.query<{ packet_json: string }, [string]>(`
        SELECT packet_json FROM btcc_subsession_delegations WHERE relation_id = ?
      `).get(incompleteCreated.relation.relation_id);
      if (!packetRow) throw new Error("incomplete packet row missing");
      const packet = JSON.parse(packetRow.packet_json) as Record<string, unknown>;
      delete packet.parent_work_ref;
      agentDb.query(`
        UPDATE btcc_subsession_delegations SET packet_json = ? WHERE relation_id = ?
      `).run(JSON.stringify(packet), incompleteCreated.relation.relation_id);
    } finally {
      agentDb.close();
    }
    await expect(composition.subsessions.ensureChildRootWork({
      childSessionId: incompleteCreated.relation.child_session_id,
      childTurnId: incompleteCreated.child_turn_id,
      objective: "must not be used",
    })).rejects.toThrow("delegation_context_incomplete");
    const noChildWork = new Database(join(root, "agent-runtime", "btcc.sqlite"), {
      readonly: true,
    });
    try {
      expect(noChildWork.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM btcc_guided_turn_work_bindings
        WHERE turn_id = ?
      `).get(incompleteCreated.child_turn_id)?.count).toBe(0);
    } finally {
      noChildWork.close();
    }

    await drain(inbound, queue, gateway, bindings, deliveryGuard);
    expect(blockedDispositionCalls).toBe(1);
    const messagesResponse = await fetch(`${app.url}messages?chat_id=general`, {
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(messagesResponse.status).toBe(200);
    const messagesBody = await messagesResponse.json() as {
      data: { messages: Array<{ role: string; text?: string; content?: string }> };
    };
    const assistantTexts = messagesBody.data.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.text ?? message.content ?? "")
      .filter((text) => text.startsWith("Terminal synthesis "));
    expect(assistantTexts).toHaveLength(4);
    for (const expectedText of [
      "Terminal synthesis blocked.",
      "Terminal synthesis cancelled.",
      "Terminal synthesis cancelled.",
      "Terminal synthesis blocked.",
    ]) {
      expect(assistantTexts).toContain(expectedText);
    }
    expect(assistantTexts.every((text) => !text.includes("terminal-result.txt"))).toBe(true);

    const finalDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), { readonly: true });
    try {
      const rows = finalDb.query<{ status: string; code: string | null }, []>(`
        SELECT status, code FROM btcc_steward_results ORDER BY created_at ASC
      `).all();
      expect(rows).toHaveLength(4);
      for (const expected of [
        { status: "blocked", code: null },
        { status: "cancelled", code: "steward_cancelled" },
        { status: "cancelled", code: "steward_cancelled" },
        { status: "blocked", code: "delegation_context_incomplete" },
      ]) {
        expect(rows).toContainEqual(expected);
      }
      const blockedRelation = finalDb.query<{
        relation_id: string;
        parent_session_id: string;
        child_session_id: string;
      }, []>(`
        SELECT r.relation_id, r.parent_session_id, r.child_session_id
        FROM btcc_steward_results s
        JOIN btcc_session_relations r ON r.relation_id = s.relation_id
        WHERE s.status = 'blocked' AND s.code IS NULL
      `).all();
      expect(blockedRelation).toHaveLength(1);
      const blockedResult = finalDb.query<{
        acceptance_evidence_json: string;
        changed_artifacts_json: string;
        remaining_risks_json: string;
      }, [string]>(`
        SELECT acceptance_evidence_json, changed_artifacts_json, remaining_risks_json
        FROM btcc_steward_results WHERE relation_id = ?
      `).get(blockedRelation[0]!.relation_id);
      expect(JSON.parse(blockedResult?.changed_artifacts_json ?? "[]")).toEqual([]);
      expect(JSON.parse(blockedResult?.acceptance_evidence_json ?? "[]")).toEqual([]);
      expect(JSON.parse(blockedResult?.remaining_risks_json ?? "[]")).toEqual([]);
      expect(finalDb.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM btcc_guided_effects
        WHERE work_id IN (
          SELECT work_id FROM btcc_guided_works WHERE session_id = ?
        ) AND status = 'applied'
      `).get(blockedRelation[0]!.child_session_id)?.count).toBe(1);
      expect(finalDb.query<{ status: string }, [string]>(`
        SELECT status FROM btcc_guided_works WHERE session_id = ?
      `).all(blockedRelation[0]!.child_session_id)).toEqual([{ status: "blocked" }]);
      expect(finalDb.query<{ status: string }, [string]>(`
        SELECT status FROM btcc_subsession_outbox WHERE relation_id = ?
      `).all(blockedRelation[0]!.relation_id)).toEqual([{ status: "delivered" }]);
      const parentSessionId = sessionHintForRow("general");
      const blockedSynthesisTurns = finalDb.query<{
        turn_id: string;
        canonical_assistant_message_id: string | null;
      }, [string]>(`
        SELECT turn_id, canonical_assistant_message_id FROM btcc_turns
        WHERE session_id = ?
          AND original_message LIKE '%Status: blocked%'
          AND original_message NOT LIKE '%Code: delegation_context_incomplete%'
      `).all(parentSessionId);
      expect(blockedSynthesisTurns).toHaveLength(1);
      const blockedCanonicalMessageId = blockedSynthesisTurns[0]!.canonical_assistant_message_id;
      if (!blockedCanonicalMessageId) throw new Error("blocked synthesis canonical result was not persisted");
      const blockedNewest = finalDb.query<{ message_id: string; content: string }, [string]>(`
        SELECT message_id, content FROM btcc_messages
        WHERE turn_id = ? AND role = 'assistant'
        ORDER BY created_at DESC, message_id DESC
      `).all(blockedSynthesisTurns[0]!.turn_id);
      expect(blockedNewest).toEqual([{
        message_id: blockedCanonicalMessageId,
        content: "Terminal synthesis blocked.",
      }]);
      expect(finalDb.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM btcc_guided_works WHERE session_id = ?
      `).get(incompleteCreated.relation.child_session_id)?.count).toBe(0);
    } finally {
      finalDb.close();
    }
    const appDb = new Database(join(root, "app.sqlite"), { readonly: true });
    try {
      expect(appDb.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM session_queued_messages WHERE text LIKE 'Subsession result%'
      `).get()?.count).toBe(4);
      expect(appDb.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM session_queued_messages
        WHERE text LIKE 'Subsession result%'
          AND text LIKE '%Status: blocked%'
          AND text NOT LIKE '%Code: delegation_context_incomplete%'
      `).get()?.count).toBe(1);
      const cancelledControls = appDb.query<{ controls_json: string }, []>(`
        SELECT controls_json FROM session_queued_messages
        WHERE text LIKE 'Subsession result%' AND text LIKE '%Status: cancelled%'
        ORDER BY created_at ASC
      `).all().map((row) => JSON.parse(row.controls_json) as { access_mode?: string });
      expect(cancelledControls.map((controls) => controls.access_mode)).toEqual([
        "read_only", "ask_first",
      ]);
    } finally {
      appDb.close();
    }
  } finally {
    app.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

test("pending Steward outbox handoff failure rejects startup recovery and preserves the row", async () => {
  const pending = {
    result_id: "result-recovery-readiness",
    relation_id: "relation-recovery-readiness",
    parent_session_id: "parent-recovery-readiness",
    parent_turn_id: "turn-recovery-readiness",
    parent_chat_id: "general",
    message_id: "message-recovery-readiness",
    safe_title: "Recover pending Steward result",
    text: "Steward result pending.",
    model_ref: "openai/gpt-5.5",
    reasoning_effort: "low",
    access_mode: "full_access" as const,
    timestamp: new Date().toISOString(),
  };
  let markedDelivered = false;
  const store = {
    pendingParentInputs: () => [pending],
    relationByChildSessionId: () => null,
    resultByRelationId: () => null,
    markParentInputDelivered: () => { markedDelivered = true; },
  } as unknown as SubsessionDelegationStore;
  await expect(recoverPendingParentInputs({
    store,
    sink: async () => { throw new Error("app_subsession_result_ingress_401"); },
  })).rejects.toThrow("app_subsession_result_ingress_401");
  expect(markedDelivered).toBe(false);
  expect(store.pendingParentInputs()).toEqual([pending]);
});

test("late Worker result is acknowledged without waking a terminal Steward", async () => {
  const pending = {
    result_id: "result-worker-after-steward-terminal",
    relation_id: "relation-worker-after-steward-terminal",
    parent_session_id: "steward-terminal",
    parent_turn_id: "turn-steward-terminal",
    parent_chat_id: "steward-terminal",
    message_id: "message-worker-after-steward-terminal",
    safe_title: "Late Worker result",
    text: "Worker result after the owning Steward stopped.",
    model_ref: "openai/gpt-5.6-luna",
    reasoning_effort: "max",
    access_mode: "full_access" as const,
    timestamp: new Date().toISOString(),
  };
  let sinkCalls = 0;
  const deliveredResultIds: string[] = [];
  const store = {
    pendingParentInputs: () => [pending],
    relationByChildSessionId: (sessionId: string) => sessionId === "steward-terminal"
      ? { relation_id: "relation-owning-steward" }
      : null,
    resultByRelationId: (relationId: string) => relationId === "relation-owning-steward"
      ? { result_id: "result-owning-steward", status: "cancelled" }
      : null,
    markParentInputDelivered: (resultId: string) => { deliveredResultIds.push(resultId); },
  } as unknown as SubsessionDelegationStore;

  expect(await recoverPendingParentInputs({
    store,
    sink: async () => { sinkCalls += 1; },
  })).toEqual({ attempted: 1, delivered: 1 });
  expect(sinkCalls).toBe(0);
  expect(deliveredResultIds).toEqual([pending.result_id]);
});

test("Worker result continuation reuses the admitted Steward Work", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-steward-worker-result-work-"));
  roots.push(root);
  initializeGitWorkspace(root);
  publishNativeReadiness(root);
  const authToken = "steward-worker-result-auth-token-012345678901234567";
  const bindings = new SessionBindingStore(
    join(root, "runtime", "session-store.sqlite"),
    "ephemeral",
  );
  const parentSessionId = sessionHintForRow("general");
  bindings.upsert({
    sessionId: parentSessionId,
    role: "butler",
    workspacePath: root,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.5",
    transportBindings: [{ transport: "app", accountId: "local", peerId: "general" }],
  });
  const app = createAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerHome: root,
    butlerData: root,
    port: 0,
    localAuth: { required: true, token: authToken },
  });
  const composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "steward-worker-result-work-test",
    sessionBindings: bindings,
    appServerUrl: app.url,
    appLocalAuth: { required: true, token: authToken },
    modelRound: { async runRound() { return { text: "unused", toolCalls: [] }; } },
  });
  try {
    const parentTurnId = "parent-turn-worker-result-work";
    const reviewed = await installReviewedDelegationPlan({
      dbPath: join(root, "agent-runtime", "btcc.sqlite"),
      sessionId: parentSessionId,
      turnId: parentTurnId,
      objective: "Delegate one bounded Worker task and integrate its result.",
      check: "The Worker result continues the same Steward Work.",
    });
    const created = await composition.subsessions.delegate({
      parent_session_id: parentSessionId,
      parent_turn_id: parentTurnId,
      anchor_message_id: "anchor-worker-result-work",
      parent_access_mode: "full_access",
      execution_mode: "mutation",
      safe_title: "Integrate Worker result",
      objective: reviewed.objective,
      acceptance_criteria: reviewed.acceptance_criteria,
      task_or_plan_refs: reviewed.task_or_plan_refs,
      constraints_and_non_goals: [],
      allowed_tools_and_effects: ["write_file:workspace"],
      mutation_scope: ["worker-result.txt"],
      parent_work_ref: reviewed.parent_work_ref,
      model_ref: "openai/gpt-5.5",
      reasoning_effort: "low",
    });
    const dbPath = join(root, "agent-runtime", "btcc.sqlite");
    admitSubsessionTurn(dbPath, created.relation.child_session_id, created.child_turn_id);
    const initialWorkId = await composition.subsessions.ensureChildRootWork({
      childSessionId: created.relation.child_session_id,
      childTurnId: created.child_turn_id,
      objective: reviewed.objective,
    });
    const continuationTurnId = `steward-worker-result-${"a".repeat(32)}`;
    admitSubsessionTurn(dbPath, created.relation.child_session_id, continuationTurnId);
    expect(await composition.subsessions.ensureChildRootWork({
      childSessionId: created.relation.child_session_id,
      childTurnId: continuationTurnId,
      objective: "Integrate the completed Worker result.",
    })).toBe(initialWorkId);

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM btcc_guided_works WHERE session_id = ?
      `).get(created.relation.child_session_id)?.count).toBe(1);
      expect(db.query<{ work_id: string }, [string]>(`
        SELECT work_id FROM btcc_guided_turn_work_bindings WHERE turn_id = ?
      `).get(continuationTurnId)?.work_id).toBe(initialWorkId);
    } finally {
      db.close();
    }
  } finally {
    app.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

test("populated current Steward results reopen through the additive detail migration", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-steward-result-migration-"));
  roots.push(root);
  const dbPath = join(root, "btcc.sqlite");
  let db = new Database(dbPath);
  db.exec(BTCC_SUBSESSION_SCHEMA);
  db.query(`
    INSERT INTO btcc_session_relations (
      relation_id, parent_session_id, parent_turn_id, child_session_id,
      anchor_message_id, ordinal, safe_title, created_at
    ) VALUES ('relation-current', 'parent-current', 'turn-parent-current',
      'child-current', 'message-current', 1, 'Current result', '2026-08-20T00:00:00.000Z')
  `).run();
  db.query(`
    INSERT INTO btcc_steward_results (
      result_id, relation_id, task_id, child_session_id, child_turn_id,
      status, code, summary, acceptance_evidence_json, changed_artifacts_json, created_at
    ) VALUES ('result-current', 'relation-current', 'task-current', 'child-current',
      'turn-child-current', 'success', NULL, 'Preserved current result.',
      '["evidence-current"]', '["artifact-current"]', '2026-08-20T00:00:01.000Z')
  `).run();
  for (const column of [
    "detail_refs_json",
    "follow_up_recommendations_json",
    "remaining_risks_json",
    "tests_json",
    "commits_json",
  ]) db.exec(`ALTER TABLE btcc_steward_results DROP COLUMN ${column}`);
  db.close();

  db = new Database(dbPath);
  migrateSubsessionResultSchema(db);
  expect(db.query<Record<string, unknown>, []>(`
    SELECT summary, acceptance_evidence_json, changed_artifacts_json,
      commits_json, tests_json, remaining_risks_json,
      follow_up_recommendations_json, detail_refs_json
    FROM btcc_steward_results
  `).get()).toEqual({
    summary: "Preserved current result.",
    acceptance_evidence_json: '["evidence-current"]',
    changed_artifacts_json: '["artifact-current"]',
    commits_json: "[]",
    tests_json: "[]",
    remaining_risks_json: "[]",
    follow_up_recommendations_json: "[]",
    detail_refs_json: "[]",
  });
  migrateSubsessionResultSchema(db);
  expect(db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM btcc_steward_results",
  ).get()?.count).toBe(1);
  db.close();
});

function recoveryRound(input: {
  childRequests: ModelRoundRequest[];
  synthesisEvidence: string[];
  busyParentStarted: Deferred<void>;
  releaseBusyParent: Deferred<void>;
  childFinalStarted: Deferred<void>;
  releaseChildFinal: Deferred<void>;
}): ModelRoundPort {
  const parentRounds = new Map<string, number>();
  const childRounds = new Map<string, number>();
  return {
    async runRound(request) {
      const body = request.messages.map((message) => message.content).join("\n");
      const isSynthesis = body.includes("Canonical child result synthesis") ||
        body.includes("Subsession result");
      const isParent = !request.instructions?.includes("Steward role");
      if (!isParent && !isSynthesis) input.childRequests.push(request);
      if (isSynthesis) {
        input.synthesisEvidence.push(body);
        return { text: "Steward result synthesized after busy parent.", toolCalls: [] };
      }
      if (isParent) {
        if (body.includes("Continue while Steward runs.")) {
          input.busyParentStarted.resolve();
          await input.releaseBusyParent.promise;
          return { text: "Second Butler response.", toolCalls: [] };
        }
        const round = (parentRounds.get("delegation") ?? 0) + 1;
        parentRounds.set("delegation", round);
        if (round === 1) return { toolCalls: [toolCall("start-parent-work", "start_work", {
          objective: "Create and verify one bounded recovery result file.",
        })] };
        if (round === 2) return { toolCalls: [toolCall("plan-parent-work", "replace_work_plan", {
          objective: "Create and verify one bounded recovery result file.",
          governing_refs: [],
          actions: [{ action_key: "delegate-reviewed-recovery-work" }],
          checks: ["recovery-result.txt contains the expected mutation"],
        })] };
        if (round === 3) return { toolCalls: [toolCall("review-parent-work", "record_work_review", {
          subject: "plan",
          verdict: "accept",
          summary: "The exact recovery objective and check are ready.",
          corrections: [],
          action_updates: [{ action_key: "delegate-reviewed-recovery-work", status: "active" }],
        })] };
        if (round > 4) return { text: "Delegation accepted.", toolCalls: [] };
        return {
          toolCalls: [toolCall("delegate", "delegate_to_steward", {
            request: "Create and verify one bounded recovery result file. The result file must contain the expected mutation.",
            safe_title: "Bounded recovery task",
          })],
        };
      }
      const childBody = request.messages.map((message) => message.content).join("\n");
      if (childBody.includes("blocked terminal result test")) {
        const workId = childBody.match(/guided-work-[a-f0-9]{64}/u)?.[0];
        if (!workId) throw new Error("blocked Steward Work id was not projected to the model");
        return { toolCalls: [toolCall("blocked", "record_work_disposition", {
          work_id: workId,
          disposition: "blocked",
          summary: "The bounded Steward task is blocked.",
          next_condition: "The required bounded input is unavailable.",
        })] };
      }
      const childKey = request.messages.map((message) => message.content)
        .find((content) => content.includes("delegation_id")) ?? "child";
      const round = (childRounds.get(childKey) ?? 0) + 1;
      childRounds.set(childKey, round);
      if (round === 1) return { toolCalls: [toolCall("plan", "replace_work_plan", {
        objective: "Create and verify one bounded recovery result file.",
        actions: [{ action_key: "write-recovery-result", description: "Write the recovery result file.", dependency_keys: [], effect: { capability: "write_file", target: "recovery-result.txt" } }, {
          action_key: "verify-recovery-result", description: "Verify the recovery result file.", dependency_keys: ["write-recovery-result"],
        }],
        checks: ["recovery-result.txt contains the expected mutation"],
      })] };
      if (round === 2) return { toolCalls: [toolCall("review-plan", "record_work_review", {
        subject: "plan", verdict: "accept", summary: "The bounded recovery mutation is ready.", action_updates: [{ action_key: "write-recovery-result", status: "active" }],
      })] };
      if (round === 3) return { toolCalls: [toolCall("write", "write_file", { path: "recovery-result.txt", content: "recovery mutation\n" })] };
      if (round === 4) return { toolCalls: [toolCall("review-result", "record_work_review", {
        subject: "result", verdict: "accept", summary: "The recovery mutation was verified.", action_updates: [{ action_key: "write-recovery-result", status: "done" }, { action_key: "verify-recovery-result", status: "done" }],
      })] };
      if (round === 5) return { toolCalls: [toolCall("review-completion", "record_work_review", {
        subject: "completion", verdict: "accept", summary: "The recovery mutation satisfies completion.", action_updates: [{ action_key: "write-recovery-result", status: "done" }, { action_key: "verify-recovery-result", status: "done" }],
      })] };
      if (round === 6) {
        input.childFinalStarted.resolve();
        await input.releaseChildFinal.promise;
        const workId = request.messages.flatMap((message) =>
          [...message.content.matchAll(/guided-work-[a-f0-9]{64}/gu)].map((match) => match[0]),
        ).at(-1);
        if (!workId) throw new Error("Steward Work id was not projected to the model");
        return { toolCalls: [toolCall("complete", "record_work_disposition", {
          work_id: workId, disposition: "completed", summary: "The recovery mutation completed.", action_updates: [{ action_key: "write-recovery-result", status: "done" }, { action_key: "verify-recovery-result", status: "done" }],
        })] };
      }
      const receiptId = request.messages.map((message) => message.content).join("\n")
        .match(/guided-effect-receipt-[a-f0-9]+/u)?.[0];
      if (!receiptId) throw new Error("Recovery receipt was not projected to the final report round");
      return { text: recoveryStewardReport(receiptId), toolCalls: [] };
    },
  };
}

async function pollUntil(
  inbound: BtccInboundDispatcher,
  queue: NativeInboundQueue,
  gateway: ReturnType<typeof createGatewayServer>,
  bindings: SessionBindingStore,
  deliveryGuard: DeliveryGuard,
  signal: Promise<void> | (() => Promise<void>),
): Promise<void> {
  inbound.poll({ queue, server: gateway, store: bindings, deliveryGuard, limit: 8, maxConcurrentSessions: 4 });
  await (typeof signal === "function" ? signal() : signal);
}

async function pollAndWait(
  inbound: BtccInboundDispatcher,
  queue: NativeInboundQueue,
  gateway: ReturnType<typeof createGatewayServer>,
  bindings: SessionBindingStore,
  deliveryGuard: DeliveryGuard,
  limit = 8,
): Promise<void> {
  inbound.poll({ queue, server: gateway, store: bindings, deliveryGuard, limit, maxConcurrentSessions: 4 });
  await inbound.waitForIdle();
}

async function drain(
  inbound: BtccInboundDispatcher,
  queue: NativeInboundQueue,
  gateway: ReturnType<typeof createGatewayServer>,
  bindings: SessionBindingStore,
  deliveryGuard: DeliveryGuard,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    inbound.poll({ queue, server: gateway, store: bindings, deliveryGuard, limit: 8, maxConcurrentSessions: 4 });
    await inbound.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForPendingResult(
  app: ReturnType<typeof createAppServer>,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = app.store.db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM session_queued_messages
      WHERE chat_id = 'general' AND text LIKE 'Subsession result%'
    `).get()?.count ?? 0;
    if (count > 0) return count;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return app.store.db.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM session_queued_messages
    WHERE chat_id = 'general' AND text LIKE 'Subsession result%'
  `).get()?.count ?? 0;
}

async function postMessage(url: string, token: string, text: string, clientMessageId: string): Promise<Response> {
  return fetch(`${url}messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ chat_id: "general", text, model: "openai/gpt-5.5", reasoning_effort: "low", access_mode: "full_access", client_message_id: clientMessageId }),
  });
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { id, name, arguments: args, rawArguments: JSON.stringify(args) };
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function initializeGitWorkspace(root: string): void {
  const run = (args: string[]) => {
    const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: root, stdout: "ignore", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  run(["init", "-q"]);
  run(["config", "user.email", "butler@example.test"]);
  run(["config", "user.name", "Butler Test"]);
  writeFileSync(join(root, "README.md"), "test\n", "utf8");
  writeFileSync(join(root, "eol.md"), "Act only from explicit evidence and preserve the exact reviewed objective.\n", "utf8");
  run(["add", "README.md"]);
  run(["commit", "-qm", "initial"]);
}

async function installReviewedDelegationPlan(input: {
  dbPath: string;
  sessionId: string;
  turnId: string;
  objective: string;
  check?: string;
  accessMode?: "full_access" | "ask_first" | "read_only";
}): Promise<ReviewedDelegationPlan> {
  const db = new Database(input.dbPath);
  const service = createDurableWorkService(new SqliteGuidedWorkStore(
    db,
    createPrincipalAuthority(new SqlitePrincipalAuthorityRepository(db)),
  ));
  try {
    const checkpointId = `checkpoint-${input.turnId}`;
    db.query(`
      INSERT INTO btcc_turns (
        turn_id, session_id, inbox_id, trigger_key, original_message_id,
        original_message, admission_snapshot_ref, model_selection_json,
        context_json, semantic_state, active_checkpoint_id, revision, execution_fence
      ) VALUES (?, ?, ?, ?, ?, ?, 'snapshot', ?, ?, 'admitted', ?, 1, 0)
    `).run(
      input.turnId,
      input.sessionId,
      `inbox-${input.turnId}`,
      `trigger-${input.turnId}`,
      `message-${input.turnId}`,
      input.objective,
      JSON.stringify({
        provider: "openai", model: "gpt-5.5", reasoningEffort: "low",
        controls: { accessMode: input.accessMode ?? "full_access" }, controlsHash: "controls",
      }),
      JSON.stringify({
        userRef: "local-user", profileRefs: [], recentFeedbackRefs: [],
        mandatoryHotCacheRefs: [], optionalHotCacheRefs: [],
        baselineObservationScopeRefs: [],
      }),
      checkpointId,
    );
    db.query(`
      INSERT INTO btcc_checkpoints (
        checkpoint_id, turn_id, turn_revision, semantic_state, kind,
        checkpoint_revision, is_active
      ) VALUES (?, ?, 1, 'admitted', 'runtime', 1, 1)
    `).run(checkpointId, input.turnId);
    const scope = { turnId: input.turnId, sessionId: input.sessionId };
    await service.startWork({
      ...scope,
      mutationCallId: `start-${input.turnId}`,
      objective: input.objective,
    });
    const planned = await service.replacePlan({
      ...scope,
      mutationCallId: `plan-${input.turnId}`,
      objective: input.objective,
      governingRefs: [],
      actions: [{
        actionKey: `delegate-${input.turnId}`,
        description: "Delegate the reviewed bounded Work.",
        dependencyKeys: [],
      }],
      checks: input.check ? [input.check] : [],
    });
    const reviewed = await service.recordReview({
      ...scope,
      mutationCallId: `review-${input.turnId}`,
      subject: "plan",
      verdict: "accept",
      summary: "The exact delegation Plan is accepted.",
      corrections: [],
    });
    if (!planned.currentPlan || !reviewed.latestPlanReview) {
      throw new Error("reviewed_delegation_fixture_invalid");
    }
    return {
      parent_work_ref: {
        work_id: reviewed.workId,
        session_id: input.sessionId,
        turn_id: input.turnId,
        plan_revision_id: planned.currentPlan.planRevisionId,
        review_revision_id: reviewed.latestPlanReview.reviewRevisionId,
      },
      objective: input.objective,
      acceptance_criteria: input.check ? [input.check] : [],
      task_or_plan_refs: [],
      actions: planned.currentPlan.actions.map((action) => ({ ...action })),
      action_progress: reviewed.actionProgress.map((progress) => ({ ...progress })),
    };
  } finally {
    db.close();
  }
}

function admitSubsessionTurn(dbPath: string, sessionId: string, turnId: string): void {
  const db = new Database(dbPath);
  try {
    const checkpointId = `checkpoint-${turnId}`;
    db.query(`
      INSERT INTO btcc_turns (
        turn_id, session_id, inbox_id, trigger_key, original_message_id,
        original_message, admission_snapshot_ref, model_selection_json,
        context_json, semantic_state, active_checkpoint_id, revision, execution_fence
      ) VALUES (?, ?, ?, ?, ?, 'subsession input', 'snapshot', ?, ?,
        'admitted', ?, 1, 0)
    `).run(
      turnId,
      sessionId,
      `inbox-${turnId}`,
      `trigger-${turnId}`,
      `message-${turnId}`,
      JSON.stringify({
        provider: "openai", model: "gpt-5.5", reasoningEffort: "low",
        controls: { accessMode: "full_access" }, controlsHash: "controls",
      }),
      JSON.stringify({
        userRef: "local-user", profileRefs: [], recentFeedbackRefs: [],
        mandatoryHotCacheRefs: [], optionalHotCacheRefs: [],
        baselineObservationScopeRefs: [],
      }),
      checkpointId,
    );
    db.query(`
      INSERT INTO btcc_checkpoints (
        checkpoint_id, turn_id, turn_revision, semantic_state, kind,
        checkpoint_revision, is_active
      ) VALUES (?, ?, 1, 'admitted', 'runtime', 1, 1)
    `).run(checkpointId, turnId);
  } finally {
    db.close();
  }
}

function publishNativeReadiness(root: string): void {
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "butler-main-native.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), runtime: "test-native-butler", launcher: "test" }), "utf8");
}

function clearNativeReadiness(root: string): void {
  rmSync(join(root, "state", "butler-main-native.json"), { force: true });
}
