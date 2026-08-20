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
import { subsessionResultClientMessageId } from "../../packages/butler-agent/src/gateways/app/interface/protocol/internal-result-contract.ts";
import { createFileToolHandlers } from "../../packages/butler-agent/src/agent/tools/file-tools/index.ts";
import { normalizeSubsessionAllowedToolsAndEffects } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/index.ts";
import { distinctMaterialReadCount } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/read-only-material-evidence.ts";
import type { GuidedToolJournalRecord } from
  "../../packages/butler-agent/src/agent/btcc/ports/guided-tool-journal.ts";

const READ_ONLY_SURFACE = [
  "grep_files:workspace",
  "list_files:workspace",
  "read_file:workspace",
  "web_read:network",
  "web_search:network",
] as const;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("App Turn delegates one bounded mutation to one Steward and synthesizes exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-one-steward-vertical-"));
  roots.push(root);
  initializeGitWorkspace(root);
  publishNativeReadiness(root);
  const authToken = "ss02-local-auth-token-012345678901234567890123";
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
  const childRequests: ModelRoundRequest[] = [];
  const composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "one-steward-vertical-test",
    sessionBindings: bindings,
    appServerUrl: app.url,
    appLocalAuth: { required: true, token: authToken },
    modelRound: oneStewardRound(childRequests),
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
  const clientMessageId = "client-steward-aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let childTurnIdForDuplicate!: string;
  let parentMessageCount!: number;
  try {
    const response = await fetch(`${app.url}messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        chat_id: "general",
        text: "Create the bounded Steward result file.",
        model: "openai/gpt-5.5",
        reasoning_effort: "low",
        access_mode: "full_access",
        client_message_id: clientMessageId,
      }),
    });
    expect(response.status).toBe(202);

    await drain(inbound, queue, gateway, bindings, deliveryGuard, root);
    await drain(inbound, queue, gateway, bindings, deliveryGuard, root);
    const appBeforeDuplicate = await readAppSnapshot(app, authToken);
    expect(appBeforeDuplicate.queueCount).toBe(1);
    expect(appBeforeDuplicate.parentInputCount).toBe(1);
    expect(appBeforeDuplicate.parentTurnCount).toBe(1);
    expect(appBeforeDuplicate.assistantResultCount).toBe(1);
    expect(appBeforeDuplicate.newestAssistantText).toBe("Steward result synthesized.");

    const btccDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), { readonly: true });
    try {
      const relation = btccDb.query<Record<string, unknown>, []>(
        "SELECT relation_id, parent_session_id, parent_turn_id, child_session_id, anchor_message_id, ordinal, safe_title, created_at FROM btcc_session_relations",
      ).get();
      const packetJson = btccDb.query<{ packet_json: string }, []>(
        "SELECT packet_json FROM btcc_subsession_delegations",
      ).get()?.packet_json ?? "";
      expect(packetJson).not.toContain(authToken);
      expect(relation).toMatchObject({
        parent_session_id: parentSessionId,
        ordinal: 1,
        safe_title: "Bounded Steward result",
      });
      const childSessionId = String(relation?.child_session_id ?? "");
      const childViewResponse = await fetch(
        `${app.url}session-view?session_id=${encodeURIComponent(childSessionId)}`,
        { headers: { authorization: `Bearer ${authToken}` } },
      );
      expect(childViewResponse.ok).toBe(true);
      const childView = await childViewResponse.json() as {
        data?: {
          relation?: { child_session_id?: string };
          messages?: Array<{ role?: string; text?: string }>;
        };
      };
      expect(childView.data?.relation?.child_session_id).toBe(childSessionId);
      const publicChildTranscript = JSON.stringify(childView.data?.messages ?? []);
      expect(publicChildTranscript).not.toContain("workspace_and_worktree");
      expect(publicChildTranscript).not.toContain("expected_result_schema");
      expect(publicChildTranscript).not.toContain("allowed_tools_and_effects");
      expect(publicChildTranscript).not.toContain("mutation_scope");
      expect(publicChildTranscript).not.toContain("delegation_id:");
    const result = btccDb.query<Record<string, unknown>, []>(
        "SELECT relation_id, status, result_id, child_turn_id FROM btcc_steward_results",
      ).get();
      childTurnIdForDuplicate = String(result?.child_turn_id ?? "");
      expect(result?.status).toBe("success");
      expect(appBeforeDuplicate.queueClientMessageIds).toEqual([
        subsessionResultClientMessageId(String(relation?.relation_id), String(result?.result_id)),
      ]);
      const rootWork = btccDb.query<{ work_id: string }, [string]>(
        "SELECT work_id FROM btcc_guided_works WHERE session_id = ?",
      ).get(String(relation?.child_session_id));
      expect(rootWork?.work_id).toBeDefined();
      expect(btccDb.query<{ status: string; capability: string; sanitized_target: string }, [string]>(
        "SELECT status, capability, sanitized_target FROM btcc_guided_effects WHERE work_id = ?",
      ).get(String(rootWork?.work_id))).toEqual({
        status: "applied",
        capability: "write_file",
        sanitized_target: "workspace:steward-result.txt",
      });
      const childTaskRequests = childRequests.filter((request) =>
        request.messages.some((message) => message.content.includes("delegation_id:")),
      );
      const childRequest = childTaskRequests[0];
      expect(childRequest?.model).toBe("openai/gpt-5.5");
      expect(childRequest?.reasoningEffort).toBe("low");
      expect(childRequest?.messages.some((message) => message.content.includes(String(rootWork?.work_id)))).toBe(true);
      const childPrompt = childRequest?.messages.map((message) => message.content).join("\n") ?? "";
      expect(childRequest?.instructions).toContain("Steward role");
      expect(childRequest?.instructions).not.toMatch(/You are Butler|Butler persona|full transcript/iu);
      for (const requiredPacketField of [
        "workspace_and_worktree",
        "expected_result_schema",
        "work_creation_policy: one_recoverable_child_work",
        "access_and_budget_policy",
        "mutation_scope: steward-result.txt",
      ]) {
        expect(childPrompt).toContain(requiredPacketField);
      }
      expect(childPrompt).not.toMatch(/Butler persona|Recent Conversation|Hot Cache|recall_memory|MCP|run_command|memory:/iu);
      const childToolNames = [...new Set(childTaskRequests.flatMap((request) =>
        request.tools.map((tool) => tool.name),
      ))].sort();
      expect(childToolNames).toEqual([
        "grep_files",
        "list_files",
        "read_file",
        "record_work_disposition",
        "record_work_review",
        "replace_work_plan",
        "write_file",
      ]);
      expect(btccDb.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_subsession_outbox",
      ).get()?.count).toBe(1);
      const outboxJson = btccDb.query<{ input_json: string }, []>(
        "SELECT input_json FROM btcc_subsession_outbox",
      ).get()?.input_json ?? "";
      expect(outboxJson).not.toContain(authToken);
      const messageText = btccDb.query<{ content: string }, []>(
        "SELECT GROUP_CONCAT(content, '\\n') AS content FROM btcc_messages",
      ).get()?.content ?? "";
      expect(messageText).not.toContain(authToken);
      expect(btccDb.query<{ status: string }, []>(
        "SELECT status FROM btcc_subsession_outbox LIMIT 1",
      ).get()?.status).toBe("delivered");
      expect(btccDb.query<{ status: string; session_id: string }, [string]>(
        "SELECT status, session_id FROM btcc_guided_works WHERE session_id != ? LIMIT 1",
      ).get(parentSessionId)).toEqual({
        status: "completed",
        session_id: expect.any(String),
      });
      const turnCount = btccDb.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM btcc_turns WHERE session_id = ?",
      ).get(parentSessionId)?.count ?? 0;
      expect(turnCount).toBe(2);
      const child = bindings.listSessions().find((session) => session.role === "steward");
      expect(child).toBeDefined();
      expect(child?.workspacePath).not.toBe(root);
      expect(await Bun.file(join(child!.workspacePath, "steward-result.txt")).text()).toBe("steward mutation\n");
      expect(await Bun.file(join(root, "steward-result.txt")).exists()).toBe(false);
      const newest = btccDb.query<{ content: string; session_id: string }, [string]>(
        "SELECT content, session_id FROM btcc_messages WHERE session_id = ? ORDER BY created_at DESC, message_id DESC LIMIT 1",
      ).get(parentSessionId);
      expect(newest?.content).toBe("Steward result synthesized.");
      expect(newest?.session_id).toBe(parentSessionId);
      parentMessageCount = btccDb.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM btcc_messages WHERE session_id = ?",
      ).get(parentSessionId)?.count ?? 0;
    } finally {
      btccDb.close();
    }

    const before = composition.subsessions?.pendingParentInputCount?.() ?? 0;
    const relation = composition.subsessions?.relationForParent(parentSessionId);
    expect(relation).toBeDefined();
    const stewardSessionCountBeforeSecond = bindings.listSessions()
      .filter((session) => session.role === "steward").length;
    await expect(composition.subsessions!.delegate({
      parent_session_id: parentSessionId,
      parent_turn_id: relation!.parent_turn_id,
      anchor_message_id: `${relation!.anchor_message_id}-second`,
      execution_mode: "mutation",
      safe_title: "Second Steward should be rejected",
      objective: "Create a second bounded Steward result file.",
      acceptance_criteria: ["The second delegation must not be created."],
      task_or_plan_refs: [],
      constraints_and_non_goals: ["Do not create a second relation or worktree."],
      allowed_tools_and_effects: ["write_file:workspace"],
      mutation_scope: ["second-steward-result.txt"],
      model_ref: "openai/gpt-5.5",
      reasoning_effort: "low",
    })).rejects.toThrow("subsession_parent_relation_exists");
    const relationDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), { readonly: true });
    try {
      expect(relationDb.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_session_relations",
      ).get()?.count).toBe(1);
    } finally {
      relationDb.close();
    }
    expect(bindings.listSessions().filter((session) => session.role === "steward"))
      .toHaveLength(stewardSessionCountBeforeSecond);
    const resultId = relation ? composition.subsessions?.resultIdForRelation(relation.relation_id) : undefined;
    expect(resultId).toBeDefined();
    await composition.subsessions?.completeStewardResult({
      childSessionId: relation!.child_session_id,
      childTurnId: childTurnIdForDuplicate,
      resultId: resultId!,
      summary: "duplicate delivery",
    });
    expect(composition.subsessions?.pendingParentInputCount?.() ?? 0).toBe(before);

    const afterDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), { readonly: true });
    try {
      expect(afterDb.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM btcc_turns WHERE session_id = ?",
      ).get(parentSessionId)?.count).toBe(2);
      expect(afterDb.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_steward_results",
      ).get()?.count).toBe(1);
      expect(afterDb.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM btcc_messages WHERE session_id = ?",
      ).get(parentSessionId)?.count).toBe(parentMessageCount);
    } finally {
      afterDb.close();
    }
    const appAfterDuplicate = await readAppSnapshot(app, authToken);
    expect(appAfterDuplicate).toEqual(appBeforeDuplicate);
  } finally {
    app.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

test("App Turn delegates one bounded read-only inspection to one Steward and synthesizes exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-read-only-steward-vertical-"));
  roots.push(root);
  initializeGitWorkspace(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".butler"), { recursive: true });
  mkdirSync(join(root, "cognition", "memory", "projects"), { recursive: true });
  mkdirSync(join(root, "cognition", "memory", "hot"), { recursive: true });
  writeFileSync(join(root, "src", "inspection-target.ts"), "export const inspected = true;\n", "utf8");
  writeFileSync(join(root, ".butler", "hot-cache.md"), "SANDY_PROJECT_HOT_CONTEXT\n", "utf8");
  writeFileSync(
    join(root, "cognition", "memory", "projects", "project-sandy.md"),
    "SANDY_PROJECT_MEMORY_CONTEXT\n",
    "utf8",
  );
  writeFileSync(
    join(root, "cognition", "memory", "hot", "cache.md"),
    "PRIVATE_USER_HOT_CONTEXT\n",
    "utf8",
  );
  publishNativeReadiness(root);
  const authToken = "ss03a-local-auth-token-012345678901234567890123";
  let bindings = new SessionBindingStore(
    join(root, "runtime", "session-store.sqlite"),
    "ephemeral",
  );
  const parentSessionId = sessionHintForRow("general");
  bindings.upsert({
    sessionId: parentSessionId,
    role: "butler",
    projectId: "project-sandy",
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
  const childRequests: ModelRoundRequest[] = [];
  const modelRound = readOnlyStewardRound(childRequests);
  let composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "read-only-steward-vertical-test",
    sessionBindings: bindings,
    appServerUrl: app.url,
    appLocalAuth: { required: true, token: authToken },
    modelRound,
  });
  const queue = new NativeInboundQueue(root);
  const inbound = new BtccInboundDispatcher();
  let gateway = createStewardGateway(composition, bindings, root);
  const deliveryGuard = new DeliveryGuard({
    adapters: [createAppTransportAdapter()],
    butlerData: root,
  });
  try {
    const readOnlyInput = {
      chat_id: "general",
      text: "Inspect the repository layout and source marker, then summarize the findings.",
      model: "openai/gpt-5.5",
      reasoning_effort: "low",
      access_mode: "full_access",
      client_message_id: "client-read-only-steward-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };
    const response = await postAppMessage(app.url, authToken, readOnlyInput);
    expect(response.status).toBe(202);
    const replay = await postAppMessage(app.url, authToken, readOnlyInput);
    expect(replay.status).toBe(202);

    inbound.poll({
      queue, server: gateway, store: bindings, deliveryGuard,
      limit: 1, maxConcurrentSessions: 1,
    });
    await inbound.waitForIdle();
    const beforeRestartDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), { readonly: true });
    const packetBeforeRestart = beforeRestartDb.query<{ packet_json: string }, []>(
      "SELECT packet_json FROM btcc_subsession_delegations",
    ).get()?.packet_json ?? "";
    const childSessionBeforeRestart = beforeRestartDb.query<{ child_session_id: string }, []>(
      "SELECT child_session_id FROM btcc_session_relations",
    ).get()?.child_session_id ?? "";
    beforeRestartDb.close();
    const bindingContextBeforeRestart = JSON.stringify(
      (bindings.getBySessionId(childSessionBeforeRestart)?.metadata?.subsession as
        Record<string, unknown> | undefined)?.project_context,
    );
    await composition.host.close();
    bindings.close();
    bindings = new SessionBindingStore(join(root, "runtime", "session-store.sqlite"), "ephemeral");
    composition = createProductionBtccComposition({
      butlerHome: root, butlerData: root, ownerId: "read-only-steward-vertical-test-restart",
      sessionBindings: bindings, appServerUrl: app.url,
      appLocalAuth: { required: true, token: authToken }, modelRound,
    });
    await composition.ready;
    gateway = createStewardGateway(composition, bindings, root);
    await drain(inbound, queue, gateway, bindings, deliveryGuard, root);
    const appSnapshot = await readAppSnapshot(app, authToken, "Read-only Steward result synthesized.");
    expect(appSnapshot.queueCount).toBe(1);
    expect(appSnapshot.parentInputCount).toBe(1);
    expect(appSnapshot.parentTurnCount).toBe(1);
    expect(appSnapshot.assistantResultCount).toBe(1);
    expect(appSnapshot.newestAssistantText).toBe("Read-only Steward result synthesized.");

    const btccDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), { readonly: true });
    try {
      const relations = btccDb.query<Record<string, unknown>, []>(
        "SELECT relation_id, parent_session_id, parent_turn_id, child_session_id, anchor_message_id, ordinal, safe_title, created_at FROM btcc_session_relations",
      ).all();
      expect(relations).toHaveLength(1);
      const relation = relations[0]!;
      const packetJson = btccDb.query<{ packet_json: string }, []>(
        "SELECT packet_json FROM btcc_subsession_delegations",
      ).get()?.packet_json ?? "";
      const packet = JSON.parse(packetJson) as Record<string, unknown>;
      expect(packetJson).toBe(packetBeforeRestart);
      expect(JSON.stringify(
        (bindings.getBySessionId(childSessionBeforeRestart)?.metadata?.subsession as
          Record<string, unknown> | undefined)?.project_context,
      )).toBe(bindingContextBeforeRestart);
      expect(packet.execution_mode).toBe("read_only");
      expect((packet.access_and_budget_policy as Record<string, unknown>).access_mode)
        .toBe("read_only");
      expect(packet.workspace_and_worktree).toEqual({
        ownership: "project",
        workspace_label: "Validated project workspace",
        repository_anchor_ref: "parent-session-project",
      });
      expect(packetJson).not.toContain(authToken);
      expect(packetJson).not.toContain(root);
      const packetContext = packet.project_context as {
        project_id: string;
        mandatory_refs: Array<{ context_ref: string; source_id: string }>;
        optional_refs: Array<{ context_ref: string; source_id: string }>;
      };
      expect([
        packetContext.project_id,
        packetContext.mandatory_refs[0]?.source_id,
        packetContext.optional_refs[0]?.source_id,
      ]).toEqual(["project-sandy", "project-hot-cache", "project-memory"]);
      expect(relation).toMatchObject({
        parent_session_id: parentSessionId,
        ordinal: 1,
        safe_title: "Read-only repository inspection",
      });
      const childSessionId = String(relation.child_session_id);
      const child = bindings.listSessions().find((session) => session.sessionId === childSessionId);
      expect(child?.role).toBe("steward");
      expect(child?.workspacePath).toBe(root);
      expect(child?.metadata?.sessionWorkspace).toBeUndefined();
      expect(child?.metadata?.subsession).toMatchObject({ execution_mode: "read_only" });
      const childViewResponse = await fetch(
        `${app.url}session-view?session_id=${encodeURIComponent(childSessionId)}`,
        { headers: { authorization: `Bearer ${authToken}` } },
      );
      expect(childViewResponse.ok).toBe(true);
      const childView = await childViewResponse.json() as {
        data?: { messages?: Array<{ role?: string; text?: string }> };
      };
      const publicChildTranscript = JSON.stringify(childView.data?.messages ?? []);
      expect(publicChildTranscript).not.toMatch(
        /workspace_and_worktree|allowed_tools_and_effects|delegation_id:|hidden reasoning/iu,
      );

      const result = btccDb.query<Record<string, unknown>, []>(
        "SELECT relation_id, status, result_id, child_turn_id, changed_artifacts_json FROM btcc_steward_results",
      ).get();
      expect(result?.status).toBe("success");
      expect(JSON.parse(String(result?.changed_artifacts_json))).toEqual([]);
      const rootWork = btccDb.query<{ work_id: string }, [string]>(
        "SELECT work_id FROM btcc_guided_works WHERE session_id = ?",
      ).get(childSessionId);
      expect(rootWork?.work_id).toBeDefined();
      expect(btccDb.query<{ status: string }, [string]>(
        "SELECT status FROM btcc_guided_works WHERE work_id = ?",
      ).get(String(rootWork?.work_id))?.status).toBe("completed");
      expect(btccDb.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM btcc_guided_effects WHERE work_id = ?",
      ).get(String(rootWork?.work_id))?.count).toBe(0);
      expect(btccDb.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM btcc_guided_effects WHERE work_id = ? AND status = 'applied' AND receipt_json IS NOT NULL",
      ).get(String(rootWork?.work_id))?.count).toBe(0);
      const childTaskRequests = childRequests.filter((request) =>
        request.messages.some((message) => message.content.includes("delegation_id:")),
      );
      expect(childTaskRequests.length).toBeGreaterThan(0);
      const childToolNames = [...new Set(childTaskRequests.flatMap((request) =>
        request.tools.map((tool) => tool.name),
      ))].sort();
      expect(childToolNames).toEqual([
        "grep_files",
        "list_files",
        "read_file",
        "record_work_disposition",
        "record_work_review",
        "replace_work_plan",
        "web_read",
        "web_search",
      ]);
      const childPrompt = childTaskRequests.flatMap((request) =>
        request.messages.map((message) => message.content),
      ).join("\n");
      expect(childPrompt).toContain("execution_mode: read_only");
      expect(childPrompt).toContain("SANDY_PROJECT_HOT_CONTEXT");
      expect(childPrompt).toContain("SANDY_PROJECT_MEMORY_CONTEXT");
      expect(childPrompt).not.toContain("PRIVATE_USER_HOT_CONTEXT");
      const childContextJson = btccDb.query<{ context_json: string }, [string]>(
        "SELECT context_json FROM btcc_turns WHERE session_id = ? ORDER BY rowid ASC LIMIT 1",
      ).get(childSessionId)?.context_json ?? "";
      const childContext = JSON.parse(childContextJson) as {
        projectRef?: string;
        mandatoryHotCacheRefs?: string[];
        optionalHotCacheRefs?: string[];
      };
      expect(childContext).toMatchObject({
        projectRef: packetContext.project_id,
        mandatoryHotCacheRefs: packetContext.mandatory_refs.map((ref) => ref.context_ref),
        optionalHotCacheRefs: packetContext.optional_refs.map((ref) => ref.context_ref),
      });
      expect(childRequests.filter((request) => request.tools.some((tool) =>
        ["write_file", "edit_file", "run_command", "call_mcp_tool"].includes(tool.name),
      ))).toHaveLength(0);
    } finally {
      btccDb.close();
    }

    const missingChatId = "missing-project-context";
    const missingParentSessionId = sessionHintForRow(missingChatId);
    const missingWorkspace = join(root, "missing-workspace");
    mkdirSync(missingWorkspace, { recursive: true });
    await fetch(`${app.url}sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        kind: "chat",
        title: "Missing project context",
        session_hint: missingChatId,
      }),
    });
    bindings.upsert({
      sessionId: missingParentSessionId,
      role: "butler",
      projectId: "project-without-memory",
      workspacePath: missingWorkspace,
      runtimeAdapterId: "btcc-turn-runtime",
      modelProviderId: "openai",
      modelRef: "openai/gpt-5.5",
      transportBindings: [{ transport: "app", accountId: "local", peerId: missingChatId }],
    });
    const childRequestCountBeforeMissing = childRequests.length;
    const missingResponse = await postAppMessage(app.url, authToken, {
      chat_id: missingChatId,
      text: "Delegate an audit that requires verified project context.",
      model: "openai/gpt-5.5",
      reasoning_effort: "low",
      access_mode: "full_access",
      client_message_id: "client-missing-context-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(missingResponse.status).toBe(202);
    await drain(inbound, queue, gateway, bindings, deliveryGuard, root);
    expect(childRequests).toHaveLength(childRequestCountBeforeMissing);
    const missingDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), { readonly: true });
    try {
      expect(missingDb.query<{ status: string; code: string; work_count: number }, [string]>(`
        SELECT result.status, result.code,
          (SELECT COUNT(*) FROM btcc_guided_works WHERE session_id = relation.child_session_id)
            AS work_count
        FROM btcc_session_relations AS relation
        JOIN btcc_steward_results AS result ON result.relation_id = relation.relation_id
        WHERE relation.parent_session_id = ?
      `).get(missingParentSessionId)).toEqual({
        status: "blocked",
        code: "delegation_context_incomplete",
        work_count: 0,
      });
    } finally {
      missingDb.close();
    }
  } finally {
    app.stop();
    await composition.host.close();
    bindings.close();
    clearNativeReadiness(root);
  }
});

test("Steward scope rejects wildcard capabilities and file boundary escapes", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-one-steward-scope-"));
  roots.push(root);
  const outside = join(root, "outside.txt");
  writeFileSync(join(root, "allowed.txt"), "before\n", "utf8");
  writeFileSync(outside, "outside\n", "utf8");
  expect(() => normalizeSubsessionAllowedToolsAndEffects(["*:workspace"], "mutation"))
    .toThrow("subsession_effect_not_allowed");
  expect(() => normalizeSubsessionAllowedToolsAndEffects(["run_command:workspace"], "mutation"))
    .toThrow("subsession_effect_not_allowed");
  expect(normalizeSubsessionAllowedToolsAndEffects(
    READ_ONLY_SURFACE,
    "read_only",
  )).toEqual([...READ_ONLY_SURFACE].sort());
  expect(() => normalizeSubsessionAllowedToolsAndEffects(
    READ_ONLY_SURFACE.slice(0, -1),
    "read_only",
  )).toThrow("subsession_read_only_surface_incomplete");

  const handlers = createFileToolHandlers({
    workspacePath: root,
    mutationScope: ["allowed.txt"],
    allowedToolsAndEffects: ["write_file:workspace"],
  });
  const outOfScopeWrite = await handlers.write_file!({
    name: "write_file",
    args: { path: "outside.txt", content: "should not write\n", overwrite: true },
    rawArguments: "{}",
  });
  expect(outOfScopeWrite).toMatchObject({ ok: false });
  expect(await Bun.file(outside).text()).toBe("outside\n");
  const absoluteWrite = await handlers.write_file!({
    name: "write_file",
    args: { path: join(root, "allowed.txt"), content: "should not write\n", overwrite: true },
    rawArguments: "{}",
  });
  expect(absoluteWrite).toMatchObject({ ok: false });
  expect(JSON.stringify(absoluteWrite)).not.toContain(root);

  const absoluteRead = await handlers.read_file!({
    name: "read_file",
    args: { requests: [{ path: join(root, "allowed.txt") }] },
    rawArguments: "{}",
  });
  expect(absoluteRead).toMatchObject({ ok: false });
  expect(JSON.stringify(absoluteRead)).not.toContain(root);
  const parentRead = await handlers.read_file!({
    name: "read_file",
    args: { requests: [{ path: "../outside.txt" }] },
    rawArguments: "{}",
  });
  expect(parentRead).toMatchObject({ ok: false });
  expect(JSON.stringify(parentRead)).not.toContain(outside);
});

test("read-only material evidence rejects empty and duplicate reads", () => {
  const read = (callId: string, path: string, result: unknown): GuidedToolJournalRecord => ({
    callId,
    toolName: "read_file",
    rawArguments: JSON.stringify({ requests: [{ path }] }),
    arguments: { requests: [{ path }] },
    status: "completed",
    result,
  });
  expect(distinctMaterialReadCount([
    read("empty-a", "src/a.ts", { files: [] }),
    read("empty-b", "src/b.ts", { files: [] }),
  ])).toBe(0);
  expect(distinctMaterialReadCount([
    read("duplicate-a", "src/a.ts", { files: [{ path: "src/a.ts", content: "marker" }] }),
    read("duplicate-b", "src/a.ts", { files: [{ path: "src/a.ts", content: "marker" }] }),
  ])).toBe(1);
  expect(distinctMaterialReadCount([
    read("material-a", "src/a.ts", { files: [{ path: "src/a.ts", content: "marker" }] }),
    read("material-b", "src/b.ts", { files: [{ path: "src/b.ts", content: "marker" }] }),
  ])).toBe(2);
});

async function readAppSnapshot(
  app: ReturnType<typeof createAppServer>,
  authToken: string,
  expectedAssistantText = "Steward result synthesized.",
): Promise<{
  queueCount: number;
  parentInputCount: number;
  parentTurnCount: number;
  assistantResultCount: number;
  newestAssistantText: string | null;
  queueClientMessageIds: string[];
}> {
  const response = await fetch(`${app.url}messages?chat_id=general`, {
    headers: { authorization: `Bearer ${authToken}` },
  });
  expect(response.status).toBe(200);
  const body = await response.json() as {
    data?: { messages?: Array<{ role?: string; text?: string; turn_id?: string }> };
  };
  const messages = body.data?.messages ?? [];
  const parentInput = messages.filter((message) =>
    message.role === "user" && message.text?.startsWith("Subsession result"),
  );
  const assistantResults = messages.filter((message) =>
    message.role === "assistant" && message.text === expectedAssistantText,
  );
  const parentTurnId = parentInput[0]?.turn_id;
  const turnsResponse = await fetch(`${app.url}turns?chat_id=general`, {
    headers: { authorization: `Bearer ${authToken}` },
  });
  expect(turnsResponse.status).toBe(200);
  const turnsBody = await turnsResponse.json() as {
    data?: { turns?: Array<{ id?: string }> };
  };
  const turns = turnsBody.data?.turns ?? [];
  const queueCount = app.store.db.query<{ count: number }, [string]>(
    "SELECT COUNT(*) AS count FROM session_queued_messages WHERE chat_id = ? AND text LIKE 'Subsession result%'",
  ).get("general")?.count ?? 0;
  const parentTurnCount = parentTurnId
    ? turns.filter((turn) => turn.id === parentTurnId).length
    : 0;
  const queueClientMessageIds = app.store.db.query<{ client_message_id: string }, [string]>(
    "SELECT client_message_id FROM session_queued_messages WHERE chat_id = ? AND text LIKE 'Subsession result%' ORDER BY rowid ASC",
  ).all("general").map((row) => row.client_message_id);
  return {
    queueCount,
    parentInputCount: parentInput.length,
    parentTurnCount,
    assistantResultCount: assistantResults.length,
    newestAssistantText: messages.at(-1)?.role === "assistant"
      ? messages.at(-1)?.text ?? null
      : null,
    queueClientMessageIds,
  };
}

function oneStewardRound(childRequests: ModelRoundRequest[]): ModelRoundPort {
  const parentRounds = new Map<string, number>();
  const childRounds = new Map<string, number>();
  return {
    async runRound(request) {
      const isParent = request.tools.some((tool) => tool.name === "delegate_to_steward");
      if (!isParent) childRequests.push(request);
      if (isParent) {
        const key = request.messages.some((message) => message.content.includes("Subsession result"))
          ? "synthesis"
          : "delegation";
        const round = (parentRounds.get(key) ?? 0) + 1;
        parentRounds.set(key, round);
        if (key === "delegation") {
          if (round > 1) return { text: "Delegation accepted.", toolCalls: [] };
          return {
            toolCalls: [toolCall("delegate", "delegate_to_steward", {
              execution_mode: "mutation",
              safe_title: "Bounded Steward result",
              objective: "Create and verify one bounded Steward result file.",
              acceptance_criteria: ["steward-result.txt contains the expected mutation"],
              task_or_plan_refs: [],
              constraints_and_non_goals: ["Do not mutate the Butler workspace or Project Ledger."],
              allowed_tools_and_effects: ["write_file:workspace"],
              mutation_scope: ["steward-result.txt"],
            })],
          };
        }
        return { text: "Steward result synthesized.", toolCalls: [] };
      }
      const childKey = request.messages.map((message) => message.content).find((content) => content.includes("delegation_id")) ?? "child";
      const round = (childRounds.get(childKey) ?? 0) + 1;
      childRounds.set(childKey, round);
      if (round === 1) {
        return {
          toolCalls: [toolCall("plan", "replace_work_plan", {
            objective: "Create and verify one bounded Steward result file.",
            actions: [{
              action_key: "write-steward-result",
              description: "Write the bounded result file.",
              dependency_keys: [],
              effect: { capability: "write_file", target: "steward-result.txt" },
            }],
            checks: ["steward-result.txt contains the expected mutation"],
          })],
        };
      }
      if (round === 2) {
        return {
          toolCalls: [toolCall("review-plan", "record_work_review", {
            subject: "plan",
            verdict: "accept",
            summary: "The bounded mutation is ready.",
            action_updates: [{ action_key: "write-steward-result", status: "active" }],
          })],
        };
      }
      if (round === 3) {
        return {
          toolCalls: [toolCall("write", "write_file", {
            path: "steward-result.txt",
            content: "steward mutation\n",
          })],
        };
      }
      if (round === 4) {
        return {
          toolCalls: [toolCall("review-result", "record_work_review", {
            subject: "result",
            verdict: "accept",
            summary: "The bounded mutation was verified.",
            action_updates: [{ action_key: "write-steward-result", status: "done" }],
          })],
        };
      }
      if (round === 5) {
        return {
          toolCalls: [toolCall("review-completion", "record_work_review", {
            subject: "completion",
            verdict: "accept",
            summary: "The applied mutation and file evidence satisfy completion.",
            action_updates: [{ action_key: "write-steward-result", status: "done" }],
          })],
        };
      }
      if (round === 6) {
        const workId = request.messages
          .flatMap((message) => [...message.content.matchAll(/guided-work-[a-f0-9]{64}/gu)].map((match) => match[0]))
          .at(-1);
        if (!workId) throw new Error("Steward Work id was not projected to the model");
        return {
          toolCalls: [toolCall("complete", "record_work_disposition", {
            work_id: workId,
            disposition: "completed",
            summary: "The bounded Steward mutation completed.",
            action_updates: [{ action_key: "write-steward-result", status: "done" }],
          })],
        };
      }
      return { text: "Steward mutation verified.", toolCalls: [] };
    },
  };
}

function readOnlyStewardRound(childRequests: ModelRoundRequest[]): ModelRoundPort {
  const parentRounds = new Map<string, number>();
  const childRounds = new Map<string, number>();
  return {
    async runRound(request) {
      const isParent = request.tools.some((tool) => tool.name === "delegate_to_steward");
      if (!isParent) childRequests.push(request);
      if (isParent) {
        const missingContext = request.messages.some((message) =>
          message.content.includes("requires verified project context") ||
          message.content.includes("delegation_context_incomplete"),
        );
        const key = `${missingContext ? "missing-" : ""}${
          request.messages.some((message) => message.content.includes("Subsession result"))
            ? "synthesis"
            : "delegation"
        }`;
        const round = (parentRounds.get(key) ?? 0) + 1;
        parentRounds.set(key, round);
        if (key.endsWith("delegation")) {
          if (round > 1) return { text: "Delegation accepted.", toolCalls: [] };
          if (missingContext) {
            return {
              toolCalls: [toolCall("delegate-missing-context", "delegate_to_steward", {
                execution_mode: "read_only",
                safe_title: "Missing project context audit",
                objective: "Audit the project using the required verified project context.",
                acceptance_criteria: ["Use the verified project context instead of guessing."],
                task_or_plan_refs: ["W-SANDY-RELATIONSHIP-AUDIT-001"],
                constraints_and_non_goals: ["Do not guess or scan when required context is unavailable."],
                allowed_tools_and_effects: [...READ_ONLY_SURFACE],
                mutation_scope: [],
              })],
            };
          }
          return {
            toolCalls: [toolCall("delegate-read-only", "delegate_to_steward", {
              execution_mode: "read_only",
              safe_title: "Read-only repository inspection",
              objective: "Inspect the repository layout and source marker, then summarize the findings.",
              acceptance_criteria: ["The layout and source marker are inspected with material read evidence."],
              task_or_plan_refs: ["W-SANDY-RELATIONSHIP-AUDIT-001"],
              constraints_and_non_goals: ["Do not mutate the workspace, run commands, call MCP, or change Project Ledger."],
              allowed_tools_and_effects: [
                "read_file:workspace",
                "list_files:workspace",
                "grep_files:workspace",
                "web_search:network",
                "web_read:network",
              ],
              mutation_scope: [],
            })],
          };
        }
        return {
          text: missingContext
            ? "Steward was blocked because required project context was unavailable."
            : "Read-only Steward result synthesized.",
          toolCalls: [],
        };
      }
      const childKey = request.messages.map((message) => message.content).find((content) => content.includes("delegation_id")) ?? "child";
      const round = (childRounds.get(childKey) ?? 0) + 1;
      childRounds.set(childKey, round);
      if (round === 1) {
        return {
          toolCalls: [toolCall("plan-read-only", "replace_work_plan", {
            objective: "Inspect the repository layout and source marker, then summarize the findings.",
            actions: [{
              action_key: "inspect-repository-evidence",
              description: "Inspect the repository layout and source marker.",
              dependency_keys: [],
            }],
            checks: ["At least two material read operations support the summary."],
          })],
        };
      }
      if (round === 2) {
        return {
          toolCalls: [toolCall("review-read-only-plan", "record_work_review", {
            subject: "plan",
            verdict: "accept",
            summary: "The bounded read-only inspection plan is ready.",
            action_updates: [{ action_key: "inspect-repository-evidence", status: "active" }],
          })],
        };
      }
      if (round === 3) {
        return {
          toolCalls: [toolCall("list-files", "list_files", {
            root: ".",
            include_globs: ["README.md", "src/**"],
            max_results: 20,
          })],
        };
      }
      if (round === 4) {
        return {
          toolCalls: [toolCall("read-source-marker", "read_file", {
            requests: [{ path: "src/inspection-target.ts" }],
          })],
        };
      }
      if (round === 5) {
        return {
          toolCalls: [toolCall("review-read-only-result", "record_work_review", {
            subject: "result",
            verdict: "accept",
            summary: "The repository layout and source marker provide the requested evidence.",
            action_updates: [{ action_key: "inspect-repository-evidence", status: "done" }],
          })],
        };
      }
      if (round === 6) {
        return {
          toolCalls: [toolCall("review-read-only-completion", "record_work_review", {
            subject: "completion",
            verdict: "accept",
            summary: "The effect-free inspection is complete with two material reads.",
            action_updates: [{ action_key: "inspect-repository-evidence", status: "done" }],
          })],
        };
      }
      if (round === 7) {
        const workId = request.messages
          .flatMap((message) => [...message.content.matchAll(/guided-work-[a-f0-9]{64}/gu)].map((match) => match[0]))
          .at(-1);
        if (!workId) throw new Error("Read-only Steward Work id was not projected to the model");
        return {
          toolCalls: [toolCall("complete-read-only", "record_work_disposition", {
            work_id: workId,
            disposition: "completed",
            summary: "The bounded read-only inspection completed with no effects.",
            action_updates: [{ action_key: "inspect-repository-evidence", status: "done" }],
          })],
        };
      }
      return { text: "Read-only repository inspection verified.", toolCalls: [] };
    },
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { id, name, arguments: args, rawArguments: JSON.stringify(args) };
}

function createStewardGateway(
  composition: ReturnType<typeof createProductionBtccComposition>,
  bindings: SessionBindingStore,
  butlerData: string,
) {
  return createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({
      btcc: composition.btcc,
      subsessionDelegation: composition.subsessions,
    }),
    butlerData,
  });
}

function postAppMessage(
  appUrl: string,
  authToken: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${appUrl}messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
    body: JSON.stringify(body),
  });
}

async function drain(
  inbound: BtccInboundDispatcher,
  queue: NativeInboundQueue,
  gateway: ReturnType<typeof createGatewayServer>,
  bindings: SessionBindingStore,
  deliveryGuard: DeliveryGuard,
  butlerData: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const summary = inbound.poll({
      queue,
      server: gateway,
      store: bindings,
      deliveryGuard,
      limit: 8,
      maxConcurrentSessions: 4,
    });
    await inbound.waitForIdle();
    if (summary.claimed === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  void butlerData;
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
  run(["add", "README.md"]);
  run(["commit", "-qm", "initial"]);
}

function publishNativeReadiness(root: string): void {
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "butler-main-native.json"), JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    runtime: "test-native-butler",
    launcher: "test",
  }), "utf8");
}

function clearNativeReadiness(root: string): void {
  rmSync(join(root, "state", "butler-main-native.json"), { force: true });
}
