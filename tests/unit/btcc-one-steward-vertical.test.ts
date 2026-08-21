/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import type { DelegationRequest } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/contracts.ts";
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

const DETAILED_STEWARD_REPORT = JSON.stringify({
  status: "success",
  version: 1,
  summary: {
    final_judgment: "verified",
    conclusion: "The requested repository source marker is present and verified.",
    evidence: [
      "README.md and src/inspection-target.ts provide the two distinct material reads behind this conclusion.",
    ],
    remaining_risks: [
      "Runtime deployment was outside this bounded read-only inspection.",
    ],
  },
}, null, 2);

type PublicSessionView = {
  messages: Array<{
    id: string;
    role: string;
    text: string;
    chat_id?: string;
    turn_id?: string;
  }>;
  steward_children?: Array<{
    session_id: string;
    active_turn: { id: string } | null;
    latest_turn: {
      id: string;
      state: string;
      progress: { safe_progress_rows: Array<{ kind?: string }> };
    } | null;
    relation: {
      child_session_id: string;
      parent_turn_id: string;
      anchor_message_id: string;
    };
  }>;
};

function detailedMutationReport(receiptIds: readonly string[]): string {
  return [
  "Conclusion: the bounded Steward files were edited and verified.",
  `Evidence: fixtures/discovery-target.txt, fixtures/verification-target.txt, and ${receiptIds.join("; ")} match the accepted mutation and correction.`,
  "Tests: passed; validation failed before correction and passed afterward.",
  "Remaining risks: none within the bounded mutation scope.",
  ].join("\n");
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("App Turn delegates one iterative mutation Work to one Steward and synthesizes exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-one-steward-vertical-"));
  roots.push(root);
  initializeGitWorkspace(root);
  mkdirSync(join(root, "fixtures"), { recursive: true });
  writeFileSync(join(root, "fixtures", "discovery-target.txt"), "discover me\n", "utf8");
  writeFileSync(join(root, "fixtures", "verification-target.txt"), "verify me\n", "utf8");
  expect(Bun.spawnSync({
    cmd: ["git", "add", "fixtures/discovery-target.txt", "fixtures/verification-target.txt"],
    cwd: root,
    stdout: "ignore",
    stderr: "pipe",
  }).exitCode).toBe(0);
  expect(Bun.spawnSync({
    cmd: ["git", "commit", "-qm", "add discovery target"],
    cwd: root,
    stdout: "ignore",
    stderr: "pipe",
  }).exitCode).toBe(0);
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
        text: "Inspect, correct, and validate the bounded Steward fixture files.",
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
        "SELECT relation_id, status, code, result_id, child_turn_id FROM btcc_steward_results",
      ).get();
      childTurnIdForDuplicate = String(result?.child_turn_id ?? "");
      expect(result).toMatchObject({ status: "success", code: null });
      expect(appBeforeDuplicate.queueClientMessageIds).toEqual([
        subsessionResultClientMessageId(String(relation?.relation_id), String(result?.result_id)),
      ]);
      const rootWork = btccDb.query<{ work_id: string }, [string]>(
        "SELECT work_id FROM btcc_guided_works WHERE session_id = ?",
      ).get(String(relation?.child_session_id));
      expect(rootWork?.work_id).toBeDefined();
      const appliedEffects = btccDb.query<{
        status: string;
        capability: string;
        sanitized_target: string;
        receipt_id: string;
      }, [string]>(
        "SELECT status, capability, sanitized_target, receipt_id FROM btcc_guided_effects WHERE work_id = ? ORDER BY rowid ASC",
      ).all(String(rootWork?.work_id));
      expect(appliedEffects).toHaveLength(3);
      expect(appliedEffects.every((effect) => effect.status === "applied")).toBe(true);
      expect(appliedEffects[0]?.sanitized_target).toMatch(/^workspace:batch:[a-f0-9]{64}$/u);
      expect(appliedEffects[1]?.sanitized_target).toBe("workspace:fixtures/verification-target.txt");
      expect(appliedEffects[2]).toMatchObject({
        capability: "write_file",
        sanitized_target: "workspace:fixtures/.steward-validation.tmp",
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
        "mutation_scope: fixtures/",
      ]) {
        expect(childPrompt).toContain(requiredPacketField);
      }
      expect(childPrompt).not.toMatch(/Butler persona|Recent Conversation|Hot Cache|recall_memory|MCP|memory:/iu);
      const childToolNames = [...new Set(childTaskRequests.flatMap((request) =>
        request.tools.map((tool) => tool.name),
      ))].sort();
      expect(childToolNames).toEqual([
        "edit_file",
        "grep_files",
        "list_files",
        "read_file",
        "record_work_checkpoint",
        "record_work_disposition",
        "record_work_review",
        "replace_work_plan",
        "run_command",
        "web_read",
        "web_search",
        "write_file",
      ]);
      const childToolRows = btccDb.query<{
        tool_name: string;
        status: string;
        result_json: string | null;
      }, [string]>(`
        SELECT tool_name, status, result_json
        FROM btcc_guided_tool_calls
        WHERE turn_id = ? AND tool_name = 'run_command'
        ORDER BY rowid ASC
      `).all(childTurnIdForDuplicate);
      expect(childToolRows).toHaveLength(2);
      expect(childToolRows.map((row) => JSON.parse(row.result_json ?? "{}").exit_code))
        .toEqual([1, 0]);
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
      expect(existsSync(join(child!.workspacePath, "fixtures", ".steward-validation.tmp"))).toBe(false);
      expect(await Bun.file(join(child!.workspacePath, "fixtures", "discovery-target.txt")).text()).toBe("discovered\n");
      expect(await Bun.file(join(child!.workspacePath, "fixtures", "verification-target.txt")).text()).toBe("verified\n");
      expect(await Bun.file(join(root, "fixtures", "discovery-target.txt")).text()).toBe("discover me\n");
      expect(await Bun.file(join(root, "fixtures", "verification-target.txt")).text()).toBe("verify me\n");
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
    const relationReader = new Database(join(root, "agent-runtime", "btcc.sqlite"), { readonly: true });
    const relation = relationReader.query<{
      relation_id: string;
      parent_turn_id: string;
      child_session_id: string;
      anchor_message_id: string;
    }, [string]>(`
      SELECT relation_id, parent_turn_id, child_session_id, anchor_message_id
      FROM btcc_session_relations
      WHERE parent_session_id = ?
      ORDER BY ordinal ASC
      LIMIT 1
    `).get(parentSessionId);
    relationReader.close();
    expect(relation).toBeDefined();
    const stewardSessionCountBeforeSecond = bindings.listSessions()
      .filter((session) => session.role === "steward").length;
    const secondRequest = {
      parent_session_id: parentSessionId,
      parent_turn_id: relation!.parent_turn_id,
      anchor_message_id: `${relation!.anchor_message_id}-second`,
      execution_mode: "mutation",
      safe_title: "Second Steward task",
      objective: "Create a second bounded Steward result file.",
      acceptance_criteria: ["The second delegation has an isolated relation."],
      task_or_plan_refs: [],
      constraints_and_non_goals: ["Do not reuse the first relation or worktree."],
      allowed_tools_and_effects: ["write_file:workspace"],
      mutation_scope: ["second-steward-result.txt"],
      model_ref: "openai/gpt-5.5",
      reasoning_effort: "low",
    } satisfies DelegationRequest;
    const second = await composition.subsessions!.delegate(secondRequest);
    const secondReplay = await composition.subsessions!.delegate(secondRequest);
    expect(secondReplay.relation.relation_id).toBe(second.relation.relation_id);
    expect(second.relation.relation_id).not.toBe(relation!.relation_id);
    expect(second.relation.ordinal).toBe(2);
    const relationDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), { readonly: true });
    try {
      expect(relationDb.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_session_relations",
      ).get()?.count).toBe(2);
    } finally {
      relationDb.close();
    }
    expect(bindings.listSessions().filter((session) => session.role === "steward"))
      .toHaveLength(stewardSessionCountBeforeSecond + 1);
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
  const parentSynthesisRequests: ModelRoundRequest[] = [];
  let childRoundStartedResolve!: () => void;
  let releaseChildRound!: () => void;
  let childRoundGateConsumed = false;
  let childRoundReleased = false;
  const childRoundStarted = new Promise<void>((resolve) => {
    childRoundStartedResolve = resolve;
  });
  const childRoundRelease = new Promise<void>((resolve) => {
    releaseChildRound = resolve;
  });
  const releaseHeldChild = () => {
    if (childRoundReleased) return;
    childRoundReleased = true;
    releaseChildRound();
  };
  const modelRound = readOnlyStewardRound(
    childRequests,
    parentSynthesisRequests,
    async () => {
      if (childRoundGateConsumed) return;
      childRoundGateConsumed = true;
      childRoundStartedResolve();
      await childRoundRelease;
    },
  );
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
    inbound.poll({
      queue, server: gateway, store: bindings, deliveryGuard,
      limit: 8, maxConcurrentSessions: 2,
    });
    await childRoundStarted;
    let activeParentData: PublicSessionView | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const activeParentViewResponse = await fetch(
        `${app.url}session-view?session_id=general`,
        { headers: { authorization: `Bearer ${authToken}` } },
      );
      expect(activeParentViewResponse.ok).toBe(true);
      const candidate = (await activeParentViewResponse.json() as {
        data?: PublicSessionView;
      }).data;
      const candidateChild = candidate?.steward_children?.find(
        (child) => child.active_turn !== null,
      );
      const candidateParentAssistant = candidate?.messages.find(
        (message) => message.role === "assistant" &&
          message.turn_id === candidateChild?.relation.parent_turn_id,
      );
      if (candidateChild && candidateParentAssistant) {
        activeParentData = candidate;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const activeChild = activeParentData?.steward_children?.find(
      (child) => child.active_turn !== null,
    );
    expect(activeChild).toBeDefined();
    const activeMessages = activeParentData?.messages ?? [];
    const activeRelation = activeChild!.relation;
    const activeAnchor = activeMessages.find(
      (message) => message.id === activeRelation.anchor_message_id,
    );
    expect(activeAnchor).toMatchObject({
      role: "user",
      text: readOnlyInput.text,
      chat_id: "general",
    });
    const activeParentAssistant = activeMessages.find(
      (message) =>
        message.role === "assistant" &&
        message.turn_id === activeRelation.parent_turn_id,
    );
    expect(activeParentAssistant).toBeDefined();
    expect(activeMessages.some(
      (message) => message.turn_id === activeChild!.active_turn?.id,
    )).toBe(false);
    const followUpInput = {
      chat_id: "general",
      text: "While the inspection runs, answer this short follow-up.",
      model: "openai/gpt-5.5",
      reasoning_effort: "low",
      access_mode: "full_access",
      client_message_id: "client-a3138a53-93e6-478e-8665-336b5662e5fa",
    };
    expect((await postAppMessage(app.url, authToken, followUpInput)).status).toBe(202);
    let followUpQueueRow: {
      client_message_id: string;
      state: string;
      turn_id: string | null;
      dispatched_message_id: string | null;
    } | undefined;
    let followUpUserMessage: {
      id: string;
      turn_id: string | null;
      role: string;
    } | undefined;
    let followUpAssistant: {
      id: string;
      turn_id: string | null;
      role: string;
    } | undefined;
    let childStillActive = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      inbound.poll({
        queue, server: gateway, store: bindings, deliveryGuard,
        limit: 8, maxConcurrentSessions: 4,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const rawFollowUpQueueRow = app.store.db.query<{
        client_message_id: string;
        state: string;
        turn_id: string | null;
        dispatched_message_id: string | null;
      }, [string, string]>(`
        SELECT client_message_id, state, turn_id, dispatched_message_id
        FROM session_queued_messages
        WHERE chat_id = ? AND client_message_id = ?
      `).get("general", followUpInput.client_message_id);
      followUpQueueRow = rawFollowUpQueueRow
        ? {
          client_message_id: String(rawFollowUpQueueRow.client_message_id),
          state: String(rawFollowUpQueueRow.state),
          turn_id: rawFollowUpQueueRow.turn_id === null
            ? null
            : String(rawFollowUpQueueRow.turn_id),
          dispatched_message_id: rawFollowUpQueueRow.dispatched_message_id === null
            ? null
            : String(rawFollowUpQueueRow.dispatched_message_id),
        }
        : undefined;
      if (followUpQueueRow?.turn_id && followUpQueueRow.dispatched_message_id) {
        followUpUserMessage = app.store.db.query<{
          id: string;
          turn_id: string | null;
          role: string;
        }, [string, string]>(`
          SELECT id, turn_id, role
          FROM messages
          WHERE chat_id = ? AND id = ?
        `).get("general", followUpQueueRow.dispatched_message_id) ?? undefined;
        followUpAssistant = app.store.db.query<{
          id: string;
          turn_id: string | null;
          role: string;
        }, [string, string]>(`
          SELECT id, turn_id, role
          FROM messages
          WHERE chat_id = ? AND role = 'assistant' AND turn_id = ?
          ORDER BY rowid ASC
          LIMIT 1
        `).get("general", followUpQueueRow.turn_id) ?? undefined;
      }
      const checkpointResponse = await fetch(
        app.url + "session-view?session_id=general",
        { headers: { authorization: "Bearer " + authToken } },
      );
      expect(checkpointResponse.ok).toBe(true);
      const checkpoint = (await checkpointResponse.json() as {
        data?: PublicSessionView;
      }).data;
      childStillActive = Boolean(checkpoint?.steward_children?.some(
        (child) => child.session_id === activeChild!.session_id &&
          child.active_turn?.id === activeChild!.active_turn?.id,
      ));
      if (followUpAssistant && childStillActive) break;
    }
    expect(childStillActive).toBe(true);
    expect(followUpQueueRow).toBeDefined();
    const exactFollowUpQueueRow = followUpQueueRow!;
    expect(exactFollowUpQueueRow.client_message_id).toBe(followUpInput.client_message_id);
    expect(exactFollowUpQueueRow.state).toBe("dispatched");
    expect(typeof exactFollowUpQueueRow.turn_id).toBe("string");
    expect(typeof exactFollowUpQueueRow.dispatched_message_id).toBe("string");
    expect(followUpUserMessage?.id).toBe(exactFollowUpQueueRow.dispatched_message_id!);
    expect(followUpUserMessage?.role).toBe("user");
    expect(followUpUserMessage?.turn_id).toBe(exactFollowUpQueueRow.turn_id!);
    expect(followUpAssistant?.role).toBe("assistant");
    expect(followUpAssistant?.turn_id).toBe(exactFollowUpQueueRow.turn_id!);
    const steerMarker = "STEWARD_DIRECTION_MARKER_20260821";
    const steerInput = {
      chat_id: "general",
      text: `The active inspection needs a correction. Add the exact correction marker ${steerMarker} to the same work.`,
      model: "openai/gpt-5.5",
      reasoning_effort: "low",
      access_mode: "full_access",
      client_message_id: "client-steer-steward-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    expect((await postAppMessage(app.url, authToken, steerInput)).status).toBe(202);
    const directionDb = new Database(join(root, "agent-runtime", "btcc.sqlite"));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      inbound.poll({ queue, server: gateway, store: bindings, deliveryGuard, limit: 8, maxConcurrentSessions: 4 });
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (directionDb.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM btcc_subsession_directions WHERE status = 'pending'",
      ).get()?.count === 1) break;
    }
    expect(directionDb.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM btcc_subsession_directions WHERE status = 'pending'",
    ).get()?.count).toBe(1);
    releaseHeldChild();
    await inbound.waitForIdle();
    expect(childRequests.some((request) =>
      request.messages.some((message) => message.content.includes(steerMarker)),
    )).toBe(true);
    expect(directionDb.query<{ status: string; applied_child_turn_id: string }, []>(`
      SELECT status, applied_child_turn_id FROM btcc_subsession_directions
    `).get()).toEqual({
      status: "applied",
      applied_child_turn_id: activeChild!.active_turn!.id,
    });
    expect(directionDb.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM btcc_session_relations",
    ).get()?.count).toBe(1);
    directionDb.close();
    const beforeRestartDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), { readonly: true });
    const packetBeforeRestart = beforeRestartDb.query<{ packet_json: string }, []>(
      "SELECT packet_json FROM btcc_subsession_delegations",
    ).get()?.packet_json ?? "";
    const childSessionBeforeRestart = beforeRestartDb.query<{ child_session_id: string }, []>(
      "SELECT child_session_id FROM btcc_session_relations",
    ).get()?.child_session_id ?? "";
    const readOnlyResultBeforeRestart = beforeRestartDb.query<{ status: string; code: string | null }, []>(
      "SELECT status, code FROM btcc_steward_results",
    ).get();
    expect(readOnlyResultBeforeRestart).toEqual({ status: "success", code: null });
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
    const synthesizedReport = "Read-only Steward report: source marker is present and verified.";
    const appSnapshot = await readAppSnapshot(app, authToken, synthesizedReport);
    expect(appSnapshot.queueCount).toBe(1);
    expect(appSnapshot.parentInputCount).toBe(1);
    expect(appSnapshot.publicParentInputCount).toBe(0);
    expect(appSnapshot.internalMessageCreatedEventCount).toBe(0);
    expect(appSnapshot.parentTurnCount).toBe(1);
    expect(appSnapshot.assistantResultCount).toBe(1);
    expect(appSnapshot.newestAssistantText).toBe(synthesizedReport);
    const finalParentViewResponse = await fetch(
      `${app.url}session-view?session_id=general`,
      { headers: { authorization: `Bearer ${authToken}` } },
    );
    expect(finalParentViewResponse.ok).toBe(true);
    const finalParentView = await finalParentViewResponse.json() as {
      data?: PublicSessionView;
    };
    const finalParentData = finalParentView.data!;
    expect(finalParentData.messages.at(-1)?.text).toBe(synthesizedReport);
    expect(finalParentData.messages.some(
      (message) => message.role === "user" && message.text.startsWith("Subsession result\n"),
    )).toBe(false);
    const transcriptResponse = await fetch(
      `${app.url}transcript-export?session_id=general`,
      { headers: { authorization: `Bearer ${authToken}` } },
    );
    expect(transcriptResponse.ok).toBe(true);
    const transcript = await transcriptResponse.json() as {
      data?: { content?: string };
    };
    expect(transcript.data?.content).not.toContain("Subsession result\n");
    expect(finalParentData.steward_children?.every(
      (child) => child.active_turn === null,
    )).toBe(true);
    expect(finalParentData.steward_children?.every(
      (child) => child.latest_turn?.state === "delivered" &&
        child.latest_turn.progress.safe_progress_rows.length > 0,
    )).toBe(true);
    const followUpIndex = finalParentData.messages.findIndex(
      (message) => message.id === exactFollowUpQueueRow.dispatched_message_id &&
        message.role === "user" && message.text === followUpInput.text &&
        message.turn_id === exactFollowUpQueueRow.turn_id,
    );
    expect(followUpIndex).toBeGreaterThan(-1);
    expect(finalParentData.messages.some(
      (message) => message.role === "assistant" &&
        message.turn_id === exactFollowUpQueueRow.turn_id,
    )).toBe(true);
    expect(parentSynthesisRequests).toHaveLength(1);
    expect(parentSynthesisRequests[0]!.tools.some(
      (tool) => tool.name === "delegate_to_steward",
    )).toBe(false);
    const synthesisEvidence = parentSynthesisRequests[0]!.messages
      .map((message) => message.content).join("\n");
    expect(synthesisEvidence).toContain("Accepted child report evidence");
    expect(synthesisEvidence).toContain("source marker is present and verified");

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
        data?: {
          messages?: Array<{ role?: string; text?: string }>;
          latest_turn?: {
            progress?: {
              safe_progress_rows?: Array<{
                safe_tool_name?: string;
                tool_call_id?: string;
                tool_result_id?: string;
              }>;
            };
          };
        };
      };
      const publicChildTranscript = JSON.stringify(childView.data?.messages ?? []);
      expect(publicChildTranscript).not.toMatch(
        /workspace_and_worktree|allowed_tools_and_effects|delegation_id:|hidden reasoning/iu,
      );
      const readProgress = childView.data?.latest_turn?.progress?.safe_progress_rows?.find(
        (row) => row.safe_tool_name === "read_file" && row.tool_call_id && row.tool_result_id,
      );
      expect(readProgress).toBeDefined();

      const result = btccDb.query<Record<string, unknown>, []>(
        `SELECT relation_id, status, result_id, child_turn_id, summary,
          changed_artifacts_json, tests_json, remaining_risks_json,
          follow_up_recommendations_json, detail_refs_json
        FROM btcc_steward_results`,
      ).get();
      expect(result?.status).toBe("success");
      expect(String(result?.summary)).toContain("source marker is present and verified");
      expect(String(result?.summary)).not.toContain('"status"');
      const childOutputChunks = btccDb.query<{
        event_json: string;
      }, [string]>(`
        SELECT event_json
        FROM btcc_progress_events
        WHERE turn_id = ? AND event_json LIKE '%operation.output.chunk%'
        ORDER BY turn_sequence ASC, event_id ASC
      `).all(String(result?.child_turn_id));
      expect(childOutputChunks.length).toBeGreaterThan(0);
      const firstChildOutput = childOutputChunks
        .map((row) => JSON.parse(row.event_json) as {
          payload?: {
            requestId?: string;
            resultId?: string;
          };
        })
        .find((event) => event.payload?.requestId === readProgress?.tool_call_id &&
          event.payload?.resultId === readProgress?.tool_result_id);
      expect(firstChildOutput).toBeDefined();
      expect(firstChildOutput?.payload?.requestId).toBe(readProgress?.tool_call_id);
      expect(firstChildOutput?.payload?.resultId).toBe(readProgress?.tool_result_id);
      const outputPath = `turns/${encodeURIComponent(String(result?.child_turn_id))}` +
        `/operations/${encodeURIComponent(firstChildOutput?.payload?.requestId ?? "")}` +
        `/output?result_id=${encodeURIComponent(firstChildOutput?.payload?.resultId ?? "")}`;
      const outputResponse = await fetch(
        `${app.url}${outputPath}`,
        { headers: { authorization: `Bearer ${authToken}` } },
      );
      expect(outputResponse.status).toBe(200);
      const outputBody = await outputResponse.json() as {
        data?: {
          turn_id?: string;
          request_id?: string;
          result_id?: string;
          content?: string;
          complete?: boolean;
        };
      };
      expect(outputBody.data).toMatchObject({
        turn_id: String(result?.child_turn_id),
        request_id: firstChildOutput?.payload?.requestId,
        result_id: firstChildOutput?.payload?.resultId,
        complete: true,
      });
      expect(outputBody.data?.content).toContain("inspection-target.ts");
      expect(app.store.db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM app_operation_output_chunks",
      ).get()?.count).toBe(0);
      const mismatchedOutputResponse = await fetch(
        `${app.url}${outputPath.replace(
          encodeURIComponent(firstChildOutput?.payload?.resultId ?? ""),
          "0".repeat(64),
        )}`,
        { headers: { authorization: `Bearer ${authToken}` } },
      );
      expect(mismatchedOutputResponse.status).toBe(404);
      const childFinal = btccDb.query<{ final_payload_json: string }, [string]>(
        "SELECT final_payload_json FROM btcc_turns WHERE turn_id = ?",
      ).get(String(result?.child_turn_id))?.final_payload_json ?? "";
      expect(childFinal).toContain("source marker is present and verified");
      const resultOutbox = btccDb.query<{ input_json: string }, [string]>(
        "SELECT input_json FROM btcc_subsession_outbox WHERE result_id = ?",
      ).get(String(result?.result_id))?.input_json ?? "";
      expect(resultOutbox).not.toContain("Evidence: README.md establishes the repository root");
      expect(JSON.parse(String(result?.tests_json))).toEqual([]);
      expect(JSON.parse(String(result?.remaining_risks_json))).toEqual([]);
      expect(JSON.parse(String(result?.follow_up_recommendations_json))).toEqual([]);
      const detailRefs = JSON.parse(String(result?.detail_refs_json)) as string[];
      expect(detailRefs[0]?.startsWith(
        `btcc-final-payload:v1:${result?.relation_id}:${result?.result_id}:${result?.child_turn_id}:`,
      )).toBe(true);
      expect(resultOutbox).toContain(detailRefs[0]!);
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
        "record_work_checkpoint",
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

    for (const rejected of [
      { key: "unusable", text: "simulate unusable terminal report evidence" },
      { key: "private-path", text: "simulate private-path terminal report evidence" },
    ]) {
      const chatId = `${rejected.key}-steward-report`;
      const parentSessionId = sessionHintForRow(chatId);
      await fetch(`${app.url}sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ kind: "chat", title: "Rejected Steward report", session_hint: chatId }),
      });
      bindings.upsert({
        sessionId: parentSessionId, role: "butler", projectId: "project-sandy",
        workspacePath: root, runtimeAdapterId: "btcc-turn-runtime",
        modelProviderId: "openai", modelRef: "openai/gpt-5.5",
        transportBindings: [{ transport: "app", accountId: "local", peerId: chatId }],
      });
      const message = {
        chat_id: chatId,
        text: `Inspect the source marker, but ${rejected.text}.`,
        model: "openai/gpt-5.5", reasoning_effort: "low", access_mode: "full_access",
        client_message_id: `client-${rejected.key}-report-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      };
      expect((await postAppMessage(app.url, authToken, message)).status).toBe(202);
      expect((await postAppMessage(app.url, authToken, message)).status).toBe(202);
      await drain(inbound, queue, gateway, bindings, deliveryGuard, root);
      const rejectedDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), { readonly: true });
      try {
        expect(rejectedDb.query<{
          status: string; code: string; detail_refs_json: string; result_count: number;
        }, [string]>(`
          SELECT result.status, result.code, result.detail_refs_json,
            (SELECT COUNT(*) FROM btcc_steward_results AS all_results
              WHERE all_results.relation_id = relation.relation_id) AS result_count
          FROM btcc_session_relations AS relation
          JOIN btcc_steward_results AS result ON result.relation_id = relation.relation_id
          WHERE relation.parent_session_id = ?
        `).get(parentSessionId)).toEqual({
          status: "failed", code: "steward_execution_failed",
          detail_refs_json: "[]", result_count: 1,
        });
        if (rejected.key === "unusable") {
          const failedToolEvent = rejectedDb.query<{ event_json: string }, [string]>(`
            SELECT progress.event_json
            FROM btcc_progress_events AS progress
            JOIN btcc_session_relations AS relation
              ON relation.child_session_id = progress.session_id
            WHERE relation.parent_session_id = ?
              AND progress.event_json LIKE '%tool.failed%'
            ORDER BY progress.created_at ASC, progress.event_id ASC
            LIMIT 1
          `).get(parentSessionId);
          expect(failedToolEvent).toBeDefined();
          const failedTool = JSON.parse(failedToolEvent!.event_json) as {
            kind?: string;
            payload?: Record<string, unknown>;
          };
          expect(failedTool).toMatchObject({
            kind: "tool.failed",
            payload: { toolName: "read_file", operationStatus: "failed" },
          });
          expect(JSON.stringify(failedTool)).not.toContain(root);
          expect(JSON.stringify(failedTool)).not.toContain(authToken);
        }
      } finally {
        rejectedDb.close();
      }
      expect(app.store.db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM session_queued_messages
        WHERE chat_id = ? AND text LIKE 'Subsession result%'
      `).get(chatId)?.count).toBe(1);
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
    releaseHeldChild();
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
  expect(normalizeSubsessionAllowedToolsAndEffects(
    ["run_command:workspace"],
    "mutation",
  )).toEqual(["run_command:workspace"]);
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
  publicParentInputCount: number;
  internalMessageCreatedEventCount: number;
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
  const publicParentInput = messages.filter((message) =>
    message.role === "user" && message.text?.startsWith("Subsession result"),
  );
  const assistantResults = messages.filter((message) =>
    message.role === "assistant" && message.text === expectedAssistantText,
  );
  const parentInputRows = app.store.db.query<{ turn_id: string }, [string]>(`
    SELECT turn_id
    FROM messages
    WHERE chat_id = ? AND role = 'user' AND text LIKE 'Subsession result%'
    ORDER BY rowid ASC
  `).all("general");
  const parentTurnId = parentInputRows[0]?.turn_id;
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
  const internalMessageCreatedEventCount = app.store.db.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count
    FROM events
    WHERE type = 'message.created' AND payload_json LIKE '%Subsession result%'
  `).get()?.count ?? 0;
  return {
    queueCount,
    parentInputCount: parentInputRows.length,
    publicParentInputCount: publicParentInput.length,
    internalMessageCreatedEventCount,
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
      const isSynthesis = request.messages.some((message) =>
        message.content.includes("Canonical child result synthesis") ||
        message.content.includes("Subsession result"),
      );
      const isParent = request.tools.some((tool) => tool.name === "delegate_to_steward");
      if (!isParent && !isSynthesis) childRequests.push(request);
      if (isSynthesis) {
        return { text: "Steward result synthesized.", toolCalls: [] };
      }
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
              objective: "Inspect, correct, and validate two bounded Steward fixture files.",
              acceptance_criteria: ["Both fixture files contain their expected mutation and bounded validation passes"],
              task_or_plan_refs: [],
              constraints_and_non_goals: ["Do not mutate the Butler workspace or Project Ledger."],
              allowed_tools_and_effects: [
                "edit_file:workspace",
                "write_file:workspace",
                "run_command:workspace",
              ],
              mutation_scope: ["fixtures/**"],
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
            objective: "Inspect and edit two bounded Steward fixture files in one batch.",
            actions: [
              {
                action_key: "inspect-fixtures",
                description: "Inspect the two bounded fixture files.",
                dependency_keys: [],
              },
              {
                action_key: "edit-fixtures",
                description: "Apply the accepted batch edit.",
                dependency_keys: ["inspect-fixtures"],
                effect: { capability: "edit_file", target: "fixtures/" },
              },
              {
                action_key: "verify-fixtures",
                description: "Verify the resulting fixture contents.",
                dependency_keys: ["edit-fixtures"],
              },
            ],
            checks: ["Both fixture files contain their expected mutation"],
          })],
        };
      }
      if (round === 2) {
        return {
          toolCalls: [toolCall("review-plan", "record_work_review", {
            subject: "plan",
            verdict: "accept",
            summary: "The bounded mutation is ready.",
            action_updates: [{ action_key: "inspect-fixtures", status: "active" }],
          })],
        };
      }
      if (round === 3) {
        return {
          toolCalls: [toolCall("list", "list_files", {
            root: "fixtures",
          })],
        };
      }
      if (round === 4) {
        return {
          toolCalls: [toolCall("read", "read_file", {
            requests: [
              { path: "fixtures/discovery-target.txt" },
              { path: "fixtures/verification-target.txt" },
            ],
          })],
        };
      }
      if (round === 5) {
        return {
          toolCalls: [toolCall("edit", "edit_file", {
            edits: [
              {
                path: "fixtures/discovery-target.txt",
                old_text: "discover me\n",
                new_text: "discovered\n",
              },
              {
                path: "fixtures/verification-target.txt",
                old_text: "verify me\n",
                new_text: "not verified\n",
              },
            ],
          })],
        };
      }
      if (round === 6) {
        return {
          toolCalls: [toolCall("validate-failing", "run_command", {
            command: "test \"$(cat fixtures/discovery-target.txt)\" = discovered && test \"$(cat fixtures/verification-target.txt)\" = verified",
            summary: "Verify fixture contents",
            state_effect: "validation",
            validation_suite: "steward-fixture-validation",
          })],
        };
      }
      if (round === 7) {
        return {
          toolCalls: [toolCall("review-failed-validation", "record_work_review", {
            subject: "result",
            verdict: "revise",
            summary: "Validation failed because the verification fixture is still incorrect.",
            correction_scope: "planning",
            corrections: ["Replace the Plan with a focused correction and rerun validation."],
            action_updates: [
              { action_key: "inspect-fixtures", status: "done" },
              { action_key: "edit-fixtures", status: "done" },
              { action_key: "verify-fixtures", status: "blocked" },
            ],
          })],
        };
      }
      if (round === 8) {
        return {
          toolCalls: [toolCall("replan-correction", "replace_work_plan", {
            objective: "Correct and validate the two bounded Steward fixture files.",
            actions: [
              {
                action_key: "inspect-failed-validation",
                description: "Use the failed validation evidence to identify the remaining defect.",
                dependency_keys: [],
              },
              {
                action_key: "correct-verification",
                description: "Correct the remaining verification fixture.",
                dependency_keys: ["inspect-failed-validation"],
                effect: { capability: "edit_file", target: "fixtures/verification-target.txt" },
              },
              {
                action_key: "verify-correction",
                description: "Run the bounded validation again.",
                dependency_keys: ["correct-verification"],
              },
              {
                action_key: "prepare-validation-marker",
                description: "Create a transient validation marker.",
                dependency_keys: ["correct-verification"],
                effect: { capability: "write_file", target: "fixtures/" },
              },
              {
                action_key: "cleanup-validation-marker",
                description: "Remove the transient marker after validation.",
                dependency_keys: ["prepare-validation-marker"],
              },
            ],
            checks: ["The validation command passes after correction"],
          })],
        };
      }
      if (round === 9) {
        return {
          toolCalls: [toolCall("review-correction-plan", "record_work_review", {
            subject: "plan",
            verdict: "accept",
            summary: "The correction plan is grounded in the failed validation.",
            action_updates: [{ action_key: "inspect-failed-validation", status: "done" }],
          })],
        };
      }
      if (round === 10) {
        return {
          toolCalls: [toolCall("correct", "edit_file", {
            path: "fixtures/verification-target.txt",
            old_text: "not verified\n",
            new_text: "verified\n",
          })],
        };
      }
      if (round === 11) {
        return {
          toolCalls: [toolCall("write-validation-marker", "write_file", {
            path: "fixtures/.steward-validation.tmp",
            content: "validation-only\n",
          })],
        };
      }
      if (round === 12) {
        return {
          toolCalls: [toolCall("validate-passing", "run_command", {
            command: "test \"$(cat fixtures/discovery-target.txt)\" = discovered && test \"$(cat fixtures/verification-target.txt)\" = verified && rm fixtures/.steward-validation.tmp",
            summary: "Verify fixture contents",
            state_effect: "validation",
            validation_suite: "steward-fixture-validation",
          })],
        };
      }
      if (round === 13) {
        return {
          toolCalls: [toolCall("review-result", "record_work_review", {
            subject: "result",
            verdict: "accept",
            summary: "The corrected mutation passed bounded validation.",
            action_updates: [
              { action_key: "inspect-failed-validation", status: "done" },
              { action_key: "correct-verification", status: "done" },
              { action_key: "verify-correction", status: "done" },
              { action_key: "prepare-validation-marker", status: "done" },
              { action_key: "cleanup-validation-marker", status: "done" },
            ],
          })],
        };
      }
      if (round === 14) {
        return {
          toolCalls: [toolCall("review-completion", "record_work_review", {
            subject: "completion",
            verdict: "accept",
            summary: "The applied mutation and file evidence satisfy completion.",
            action_updates: [
              { action_key: "inspect-failed-validation", status: "done" },
              { action_key: "correct-verification", status: "done" },
              { action_key: "verify-correction", status: "done" },
              { action_key: "prepare-validation-marker", status: "done" },
              { action_key: "cleanup-validation-marker", status: "done" },
            ],
          })],
        };
      }
      if (round === 15) {
        const workId = request.messages
          .flatMap((message) => [...message.content.matchAll(/guided-work-[a-f0-9]{64}/gu)].map((match) => match[0]))
          .at(-1);
        if (!workId) throw new Error("Steward Work id was not projected to the model");
        return {
          toolCalls: [toolCall("complete", "record_work_disposition", {
            work_id: workId,
            disposition: "completed",
            summary: "The bounded Steward mutation completed.",
            action_updates: [
              { action_key: "inspect-failed-validation", status: "done" },
              { action_key: "correct-verification", status: "done" },
              { action_key: "verify-correction", status: "done" },
              { action_key: "prepare-validation-marker", status: "done" },
              { action_key: "cleanup-validation-marker", status: "done" },
            ],
          })],
        };
      }
      const receiptIds = [...request.messages.map((message) => message.content).join("\n")
        .matchAll(/guided-effect-receipt-[a-f0-9]+/gu)]
        .map((match) => match[0])
        .filter((value, index, values) => values.indexOf(value) === index);
      if (receiptIds.length !== 3) {
        throw new Error("All mutation receipts were not projected to the final report round");
      }
      return { text: detailedMutationReport(receiptIds), toolCalls: [] };
    },
  };
}

function readOnlyStewardRound(
  childRequests: ModelRoundRequest[],
  parentSynthesisRequests: ModelRoundRequest[],
  holdFirstChildRound?: () => Promise<void>,
): ModelRoundPort {
  const parentRounds = new Map<string, number>();
  const childRounds = new Map<string, number>();
  return {
    async runRound(request) {
      const isSynthesis = request.messages.some((message) =>
        message.content.includes("Canonical child result synthesis") ||
        message.content.includes("Subsession result"),
      );
      const isParent = request.tools.some((tool) => tool.name === "delegate_to_steward");
      if (!isParent && !isSynthesis) childRequests.push(request);
      if (isSynthesis) {
        parentSynthesisRequests.push(request);
        const unusableReport = request.messages.some((message) =>
          message.content.includes("steward_execution_failed"),
        );
        return {
          text: unusableReport
            ? "Steward failed because terminal report evidence was unusable."
            : "Read-only Steward report: source marker is present and verified.",
          toolCalls: [],
        };
      }
      if (isParent) {
        const requestText = request.messages.map((message) => message.content).join("\n");
        if (requestText.includes("Add the exact correction marker")) {
          const alreadySteered = requestText.includes("instruction_id");
          return alreadySteered
            ? { text: "The active Steward received the correction.", toolCalls: [] }
            : {
                toolCalls: [toolCall("steer-active-steward", "steer_steward", {
                  instruction: requestText.match(/STEWARD_DIRECTION_MARKER_\d+/u)?.[0] ?? "Apply the correction.",
                })],
              };
        }
        const missingContext = request.messages.some((message) =>
          message.content.includes("requires verified project context") ||
          message.content.includes("delegation_context_incomplete"),
        );
        const privatePathReport = request.messages.some((message) =>
          message.content.includes("private-path terminal report evidence"));
        const unusableReport = request.messages.some((message) =>
          message.content.includes("unusable terminal report evidence") || privatePathReport ||
          message.content.includes("steward_execution_failed"),
        );
        const key = `${missingContext ? "missing-" : privatePathReport ? "private-" : unusableReport ? "unusable-" : ""}${
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
          if (unusableReport) {
            return {
              toolCalls: [toolCall("delegate-unusable-report", "delegate_to_steward", {
                execution_mode: "read_only",
                safe_title: "Unusable report inspection",
                objective: privatePathReport
                  ? "Inspect the repository source marker with private-path terminal report evidence."
                  : "Inspect the repository source marker with unusable terminal report evidence.",
                acceptance_criteria: ["The source marker is inspected with material evidence."],
                task_or_plan_refs: ["W-SANDY-RELATIONSHIP-AUDIT-001"],
                constraints_and_non_goals: ["Do not mutate the workspace."],
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
            : unusableReport
              ? "Steward failed because terminal report evidence was unusable."
            : "Read-only Steward report: source marker is present and verified.",
          toolCalls: [],
        };
      }
      const childKey = request.messages.map((message) => message.content).find((content) => content.includes("delegation_id")) ?? "child";
      const round = (childRounds.get(childKey) ?? 0) + 1;
      childRounds.set(childKey, round);
      const simulateToolFailure = request.messages.some((message) =>
        message.content.includes("unusable terminal report evidence"),
      );
      if (round === 1) await holdFirstChildRound?.();
      if (round === 1) {
        return {
          toolCalls: [toolCall("plan-read-only", "replace_work_plan", {
            objective: "Inspect the repository layout and source marker, then summarize the findings.",
            actions: [{
              action_key: "inspect-repository-evidence",
              description: "Inspect the repository layout and source marker.",
              dependency_keys: [],
            }, {
              action_key: "synthesize-repository-evidence",
              description: "Synthesize the verified read evidence without mutation.",
              dependency_keys: ["inspect-repository-evidence"],
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
        if (simulateToolFailure) {
          return {
            toolCalls: [toolCall("read-missing-source", "read_file", {
              requests: [{ path: "src/missing-inspection-target.ts" }],
            })],
          };
        }
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
            action_updates: [
              { action_key: "inspect-repository-evidence", status: "done" },
              { action_key: "synthesize-repository-evidence", status: "done" },
            ],
          })],
        };
      }
      if (round === 6) {
        return {
          toolCalls: [toolCall("review-read-only-completion", "record_work_review", {
            subject: "completion",
            verdict: "accept",
            summary: "The effect-free inspection is complete with two material reads.",
            action_updates: [
              { action_key: "inspect-repository-evidence", status: "done" },
              { action_key: "synthesize-repository-evidence", status: "done" },
            ],
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
            action_updates: [
              { action_key: "inspect-repository-evidence", status: "done" },
              { action_key: "synthesize-repository-evidence", status: "done" },
            ],
          })],
        };
      }
      const requestBody = request.messages.map((message) => message.content).join("\n");
      return {
        text: requestBody.includes("private-path terminal report evidence")
          ? `${DETAILED_STEWARD_REPORT}\nEvidence detail: file:///private/var/secret.txt`
          : requestBody.includes("unusable terminal report evidence")
            ? "Steward completed the bounded read-only inspection with verified material evidence."
            : DETAILED_STEWARD_REPORT,
        toolCalls: [],
      };
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
