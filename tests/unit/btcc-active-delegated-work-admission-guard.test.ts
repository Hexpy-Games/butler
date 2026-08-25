/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionBtccComposition } from
  "../../packages/butler-agent/src/agent/composition/create-btcc-composition.ts";
import type { ModelRoundPort, ModelRoundRequest } from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { createAppServer } from
  "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";
import { NativeInboundQueue } from
  "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import { GatewayRouter } from
  "../../packages/butler-agent/src/gateways/core/router.ts";
import { createGatewayServer } from
  "../../packages/butler-agent/src/gateways/core/server.ts";
import { BtccInboundDispatcher } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/btcc-inbound-dispatcher.ts";
import { createBtccGatewayHandlers } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/create-btcc-gateway-handlers.ts";
import { createAppTransportAdapter } from
  "../../packages/butler-agent/src/interfaces/transport/app/adapter.ts";
import { DeliveryGuard } from
  "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { SessionBindingStore } from
  "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { sessionHintForRow } from
  "../../packages/butler-agent/src/gateways/app/domain/sessions/session-read-model.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("real second App Turn starts distinct W2 while active delegated W1 is structurally fenced", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-active-delegation-admission-"));
  roots.push(root);
  initializeGitWorkspace(root);
  publishNativeReadiness(root);
  const authToken = "active-delegation-admission-token-01234567890123456789";
  const parentSessionId = sessionHintForRow("general");
  const bindings = new SessionBindingStore(
    join(root, "runtime", "session-store.sqlite"),
    "ephemeral",
  );
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
  const rounds = admissionGuardRounds();
  const composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "active-delegation-admission-test",
    sessionBindings: bindings,
    appServerUrl: app.url,
    appLocalAuth: { required: true, token: authToken },
    modelRound: rounds,
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
    await postMessage(app.url, authToken, {
      text: "FIRST_START: create the first durable Work.",
      client_message_id: "4aaaaaaa-4aaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    inbound.poll({ queue, server: gateway, store: bindings, deliveryGuard, limit: 1 });
    await inbound.waitForIdle();

    const db = new Database(join(root, "agent-runtime", "btcc.sqlite"));
    const w1 = parentWorks(db, parentSessionId)[0];
    expect(w1).toBeDefined();
    rounds.setW1WorkId(w1!.work_id);
    expect(parentWorks(db, parentSessionId)).toEqual([
      expect.objectContaining({ work_id: w1!.work_id, status: "open" }),
    ]);

    await postMessage(app.url, authToken, {
      text: "FIRST_DELEGATE: continue, review, and delegate the first Work.",
      client_message_id: "4ccccccc-4ccc-4ccc-8ccc-cccccccccccc",
    });
    for (let attempt = 0; attempt < 5 &&
      parentDelegations(db, parentSessionId).length === 0; attempt += 1) {
      inbound.poll({ queue, server: gateway, store: bindings, deliveryGuard, limit: 1 });
      await inbound.waitForIdle();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const w1Delegation = parentDelegations(db, parentSessionId)[0];
    expect(w1Delegation).toBeDefined();
    expect(w1Delegation!.work_id).toBe(w1!.work_id);
    expect(w1Delegation!.parent_turn_id).not.toBe(w1!.origin_turn_id);
    const w1MaterialBeforeT3 = workMaterialCounts(db, w1!.work_id);

    await postMessage(app.url, authToken, {
      text: "SECOND_WORK: independently prepare and delegate another reviewed objective.",
      client_message_id: "4bbbbbbb-4bbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    const claimed = inbound.poll({
      queue,
      server: gateway,
      store: bindings,
      deliveryGuard,
      limit: 2,
      maxConcurrentSessions: 2,
    });
    expect(claimed.claimed).toBeGreaterThanOrEqual(1);
    await rounds.waitForW1Child();
    const secondClaim = inbound.poll({
      queue,
      server: gateway,
      store: bindings,
      deliveryGuard,
      limit: 1,
      maxConcurrentSessions: 2,
    });
    expect(secondClaim.claimed).toBe(1);
    await waitUntil(() => parentDelegations(db, parentSessionId).length === 2);
    rounds.releaseW1Child();
    await inbound.waitForIdle();

    const delegations = parentDelegations(db, parentSessionId);
    expect(delegations).toHaveLength(2);
    const [first, second] = delegations;
    expect(new Set(delegations.map((row) => row.parent_turn_id)).size).toBe(2);
    expect(new Set(delegations.map((row) => row.work_id)).size).toBe(2);
    expect(new Set(delegations.map((row) => row.relation_id)).size).toBe(2);
    expect(new Set(delegations.map((row) => row.child_session_id)).size).toBe(2);
    expect(new Set(delegations.map((row) => row.child_turn_id)).size).toBe(2);
    expect(first!.work_id).toBe(w1!.work_id);

    const works = parentWorks(db, parentSessionId);
    expect(works).toContainEqual(expect.objectContaining({
      work_id: first!.work_id,
      status: "abandoned",
    }));
    expect(works).toContainEqual(expect.objectContaining({
      work_id: second!.work_id,
      status: "open",
    }));
    expect(works.filter((work) => work.status === "abandoned")).toHaveLength(1);
    expect(workMaterialCounts(db, first!.work_id)).toEqual(w1MaterialBeforeT3);
    expect(rounds.forbiddenResults()).toEqual(Array(5).fill("tool_unavailable"));
    expect(rounds.w2PlanUsedStartNew()).toBe(false);
    db.close();
  } finally {
    rounds.releaseW1Child();
    app.stop();
    await composition.host.close();
    bindings.close();
  }
});

function admissionGuardRounds(): ModelRoundPort & {
  forbiddenResults(): string[];
  releaseW1Child(): void;
  setW1WorkId(workId: string): void;
  waitForW1Child(): Promise<void>;
  w2PlanUsedStartNew(): boolean;
} {
  let w1WorkId = "";
  let w2PlanStartNew = false;
  let releaseChild!: () => void;
  let childEntered!: () => void;
  const childRelease = new Promise<void>((resolve) => { releaseChild = resolve; });
  const childStarted = new Promise<void>((resolve) => { childEntered = resolve; });
  const parentRounds = new Map<"w1_start" | "w1_delegate" | "w2", number>();
  const forbiddenCodes: string[] = [];
  return {
    forbiddenResults: () => forbiddenCodes,
    releaseW1Child: () => releaseChild(),
    setW1WorkId: (workId) => { w1WorkId = workId; },
    waitForW1Child: () => childStarted,
    w2PlanUsedStartNew: () => w2PlanStartNew,
    async runRound(request) {
      if (request.instructions?.includes("Steward role")) {
        childEntered();
        await childRelease;
        return { text: "Steward stopped after the admission proof.", toolCalls: [] };
      }
      const body = request.messages.map((message) => message.content).join("\n");
      const key = body.includes("SECOND_WORK")
        ? "w2"
        : body.includes("FIRST_DELEGATE") ? "w1_delegate" : "w1_start";
      const round = (parentRounds.get(key) ?? 0) + 1;
      parentRounds.set(key, round);
      if (key === "w1_start") {
        return round === 1
          ? response("w1-start", "start_work", {
              objective: "Execute the first long-running reviewed objective.",
            })
          : { text: "The first durable Work is ready for a later Turn.", toolCalls: [] };
      }
      if (key === "w1_delegate") return w1DelegationRound(round);
      return w2Round(request, round);
    },
  };

  function w1DelegationRound(round: number) {
    if (round === 1) return response("w1-continue", "continue_work", {
      work_id: w1WorkId,
    });
    if (round === 2) return response("w1-plan", "replace_work_plan", {
      objective: "Execute the first long-running reviewed objective.",
      governing_refs: [],
      actions: [{ action_key: "delegate-first", dependency_keys: [] }],
      checks: ["The first Steward remains active."],
    });
    if (round === 3) return response("w1-review", "record_work_review", {
      subject: "plan",
      verdict: "accept",
      summary: "The first delegation Plan is accepted.",
      corrections: [],
      action_updates: [{ action_key: "delegate-first", status: "active" }],
    });
    return response("w1-delegate", "delegate_to_steward", {
      safe_title: "First active Steward",
    });
  }

  function w2Round(request: ModelRoundRequest, round: number) {
    const names = request.tools.map((tool) => tool.name);
    if (round === 1) {
      for (const required of [
        "start_work", "steer_steward", "cancel_steward", "read_file",
      ]) expect(names).toContain(required);
      for (const forbidden of [
        "continue_work", "replace_work_plan", "record_work_review",
        "record_work_disposition", "delegate_to_steward", "write_file",
        "run_command", "tool_call",
      ]) expect(names).not.toContain(forbidden);
      return {
        toolCalls: [
          call("forbidden-continue", "continue_work", { work_id: w1WorkId }),
          call("forbidden-plan", "replace_work_plan", {
            objective: "Illegally replan W1.", actions: [], checks: [],
          }),
          call("forbidden-effect", "write_file", {
            path: "forbidden.txt", content: "forbidden", overwrite: false,
          }),
          call("forbidden-redelegate", "delegate_to_steward", {}),
          call("forbidden-bridge", "tool_call", {
            id: "native:write_file",
            arguments: { path: "bridge.txt", content: "forbidden", overwrite: false },
          }),
        ],
      };
    }
    if (round === 2) {
      for (const message of request.messages.filter((item) => item.role === "tool")) {
        const parsed = JSON.parse(message.content) as { error?: { code?: string } };
        forbiddenCodes.push(parsed.error?.code ?? "missing");
      }
      return response("w2-start", "start_work", {
        objective: "Execute a distinct second reviewed objective.",
      });
    }
    if (round === 3) {
      expect(names).toContain("replace_work_plan");
      const args = {
        objective: "Execute a distinct second reviewed objective.",
        governing_refs: [],
        actions: [{ action_key: "delegate-second", dependency_keys: [] }],
        checks: ["The second Steward relation is distinct."],
      };
      w2PlanStartNew = Object.hasOwn(args, "start_new");
      return response("w2-plan", "replace_work_plan", args);
    }
    if (round === 4) return response("w2-review", "record_work_review", {
      subject: "plan",
      verdict: "accept",
      summary: "The second delegation Plan is accepted.",
      corrections: [],
      action_updates: [{ action_key: "delegate-second", status: "active" }],
    });
    expect(names).toEqual(["delegate_to_steward"]);
    return response("w2-delegate", "delegate_to_steward", {
      safe_title: "Second active Steward",
    });
  }
}

function response(id: string, name: string, args: Record<string, unknown>) {
  return { toolCalls: [call(id, name, args)] };
}

function call(id: string, name: string, args: Record<string, unknown>) {
  return { id, name, arguments: args, rawArguments: JSON.stringify(args) };
}

async function postMessage(
  appUrl: string,
  token: string,
  input: { text: string; client_message_id: string },
): Promise<void> {
  const response = await fetch(`${appUrl}messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      chat_id: "general",
      text: input.text,
      model: "openai/gpt-5.5",
      reasoning_effort: "low",
      access_mode: "full_access",
      client_message_id: input.client_message_id,
    }),
  });
  expect(response.status).toBe(202);
}

type ParentDelegationRow = {
  relation_id: string;
  parent_turn_id: string;
  child_session_id: string;
  child_turn_id: string;
  work_id: string;
};

function parentDelegations(db: Database, sessionId: string): ParentDelegationRow[] {
  return db.query<ParentDelegationRow, [string]>(`
    SELECT relation.relation_id, relation.parent_turn_id,
      relation.child_session_id, delegation.child_turn_id,
      json_extract(delegation.packet_json, '$.parent_work_ref.work_id') AS work_id
    FROM btcc_session_relations relation
    JOIN btcc_subsession_delegations delegation
      ON delegation.relation_id = relation.relation_id
    WHERE relation.parent_session_id = ?
    ORDER BY relation.ordinal
  `).all(sessionId);
}

function parentWorks(db: Database, sessionId: string): Array<{
  work_id: string;
  status: string;
  origin_turn_id: string;
}> {
  return db.query<{ work_id: string; status: string; origin_turn_id: string }, [string]>(`
    SELECT work_id, status, origin_turn_id FROM btcc_guided_works
    WHERE session_id = ? ORDER BY created_at
  `).all(sessionId);
}

function workMaterialCounts(db: Database, workId: string) {
  const count = (table: string) => db.query<{ count: number }, [string]>(
    `SELECT COUNT(*) AS count FROM ${table} WHERE work_id = ?`,
  ).get(workId)?.count ?? 0;
  return {
    plans: count("btcc_guided_work_plan_revisions"),
    reviews: count("btcc_guided_work_review_revisions"),
    dispositions: count("btcc_guided_work_disposition_revisions"),
    effects: count("btcc_guided_effects"),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed_out_waiting_for_second_parent_delegation");
}

function initializeGitWorkspace(root: string): void {
  const run = (args: string[]) => {
    const result = Bun.spawnSync({
      cmd: ["git", ...args], cwd: root, stdout: "ignore", stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  run(["init", "-q"]);
  run(["config", "user.email", "butler@example.test"]);
  run(["config", "user.name", "Butler Test"]);
  writeFileSync(join(root, "README.md"), "admission guard fixture\n", "utf8");
  writeFileSync(join(root, "eol.md"), "Preserve exact reviewed ownership.\n", "utf8");
  run(["add", "README.md", "eol.md"]);
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
