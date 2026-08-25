/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionBtccComposition } from
  "../../packages/butler-agent/src/agent/composition/create-btcc-composition.ts";
import type { ModelRoundPort } from
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

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("real App delegation preserves distinct child identities through Steward Work selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-steward-child-project-identity-"));
  roots.push(root);
  publishNativeReadiness(root);
  writeFileSync(join(root, "eol.md"), "Preserve exact reviewed project identity.\n", "utf8");
  const appDbPath = join(root, "app.sqlite");
  const bindingPath = join(root, "runtime", "session-store.sqlite");
  const authToken = "child-project-identity-auth-token-01234567890123456789";
  let bindings = new SessionBindingStore(bindingPath, "ephemeral");
  const app = createAppServer({
    dbPath: appDbPath,
    butlerHome: root,
    butlerData: root,
    projectWorkspaceRoot: join(root, "projects"),
    port: 0,
    localAuth: { required: true, token: authToken },
  });
  const projectResponse = await postJson<{ project: { id: string } }>(app.url, authToken, "projects", {
    source: "scratch",
    display_name: "Exact child identity",
  });
  const appProjectId = projectResponse.data.project.id;
  const ledgerProjectId = "ledger-exact-child-identity";
  const appDb = new Database(appDbPath);
  const workspacePath = appDb.query<{ workspace_path: string }, [string]>(`
    SELECT workspace_path FROM projects WHERE id = ?
  `).get(appProjectId)?.workspace_path;
  if (!workspacePath) throw new Error("created App project workspace missing");
  appDb.query("UPDATE projects SET ledger_project_id = ? WHERE id = ?")
    .run(ledgerProjectId, appProjectId);
  appDb.close();
  initializeGitWorkspace(workspacePath);
  const sessionResponse = await postJson<{ session: { id: string } }>(app.url, authToken, "sessions", {
    kind: "project",
    project_id: appProjectId,
    title: "Delegate exact child identity",
  });
  const chatId = sessionResponse.data.session.id;

  const rounds = delegationRounds();
  const composition = createProductionBtccComposition({
    butlerHome: process.cwd(),
    butlerData: root,
    ownerId: "child-project-identity-real-path",
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
    const posted = await postJson<{ turn: { state: string } }>(app.url, authToken, "messages", {
      chat_id: chatId,
      text: "Delegate this reviewed project task to one Steward.",
      model: "openai/gpt-5.5",
      reasoning_effort: "low",
      access_mode: "full_access",
      client_message_id: "4aaaaaaa-4aaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(posted.data.turn.state).toBe("thinking");

    for (let attempt = 0; attempt < 5 && rounds.parentCalls() === 0; attempt += 1) {
      inbound.poll({ queue, server: gateway, store: bindings, deliveryGuard, limit: 1 });
      await inbound.waitForIdle();
    }
    expect(rounds.parentCalls()).toBeGreaterThanOrEqual(4);
    const relationDb = new Database(join(root, "agent-runtime", "btcc.sqlite"), {
      readonly: true,
    });
    const childIdentity = relationDb.query<{
      child_session_id: string;
      root_work_id: string;
    }, []>(`
      SELECT r.child_session_id, d.root_work_id
      FROM btcc_session_relations r
      JOIN btcc_subsession_delegations d ON d.relation_id = r.relation_id
      LIMIT 1
    `).get();
    relationDb.close();
    if (!childIdentity) throw new Error(rounds.lastParentBody());
    const childSessionId = childIdentity.child_session_id;
    expect(bindings.getBySessionId(childSessionId)).toMatchObject({
      projectId: appProjectId,
      appProjectId,
      ledgerProjectId,
      role: "steward",
    });

    inbound.poll({ queue, server: gateway, store: bindings, deliveryGuard, limit: 1 });
    await inbound.waitForIdle();
    expect(rounds.childCalls()).toBeGreaterThan(0);
    expect(bindings.getBySessionId(childSessionId)).toMatchObject({
      projectId: appProjectId,
      appProjectId,
      ledgerProjectId,
      role: "steward",
    });

    const ledgerRoot = join(root, "project-ledger", "projects", ledgerProjectId);
    expect(existsSync(join(ledgerRoot, "project.json"))).toBe(true);
    expect(existsSync(join(ledgerRoot, "ledger.jsonl"))).toBe(true);
    expect(readdirSync(join(ledgerRoot, "work")).length).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(
      ledgerRoot,
      "work",
      childIdentity.root_work_id,
      "work.md",
    ))).toBe(true);
    expect(existsSync(join(root, "project-ledger", "projects", appProjectId))).toBe(false);
  } finally {
    app.stop();
    await composition.host.close();
    bindings.close();
  }

  bindings = new SessionBindingStore(bindingPath, "ephemeral");
  try {
    const child = bindings.listSessions().find((binding) => binding.role === "steward");
    expect(child).toMatchObject({
      projectId: appProjectId,
      appProjectId,
      ledgerProjectId,
    });
  } finally {
    bindings.close();
  }
});

function delegationRounds(): ModelRoundPort & {
  childCalls(): number;
  parentCalls(): number;
  lastParentBody(): string;
} {
  let parentRound = 0;
  let stewardCalls = 0;
  let lastParentBody = "reviewed App delegation did not persist a child";
  return {
    childCalls: () => stewardCalls,
    parentCalls: () => parentRound,
    lastParentBody: () => lastParentBody,
    async runRound(request) {
      if (request.instructions?.includes("Steward role")) {
        stewardCalls += 1;
        return { text: "Conclusion: verified the exact delegated project identity.", toolCalls: [] };
      }
      lastParentBody = request.messages.map((message) => message.content).join("\n");
      parentRound += 1;
      if (parentRound === 1) return { toolCalls: [toolCall("start", "start_work", {
        objective: "Verify exact child project identity inheritance.",
      })] };
      if (parentRound === 2) return { toolCalls: [toolCall("plan", "replace_work_plan", {
        objective: "Verify exact child project identity inheritance.",
        governing_refs: [],
        actions: [{
          action_key: "delegate-identity-check",
          description: "Delegate the exact reviewed project identity check.",
          dependency_keys: [],
        }],
        checks: ["Child Work uses only the exact Ledger project identity."],
      })] };
      if (parentRound === 3) return { toolCalls: [toolCall("review", "record_work_review", {
        subject: "plan",
        verdict: "accept",
        summary: "The exact identity delegation Plan is accepted.",
        corrections: [],
        action_updates: [{ action_key: "delegate-identity-check", status: "active" }],
      })] };
      if (parentRound === 4) return { toolCalls: [toolCall("delegate", "delegate_to_steward", {
        safe_title: "Exact child project identity",
      })] };
      return { text: "The reviewed delegation was queued.", toolCalls: [] };
    },
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { id, name, arguments: args, rawArguments: JSON.stringify(args) };
}

async function postJson<T>(
  baseUrl: string,
  token: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ data: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBeLessThan(300);
  return response.json() as Promise<{ data: T }>;
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

function initializeGitWorkspace(workspacePath: string): void {
  const run = (args: string[]) => {
    const result = Bun.spawnSync({
      cmd: ["git", ...args],
      cwd: workspacePath,
      stdout: "ignore",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  run(["init", "-q"]);
  run(["config", "user.email", "butler@example.test"]);
  run(["config", "user.name", "Butler Test"]);
  writeFileSync(join(workspacePath, "README.md"), "exact child identity\n", "utf8");
  run(["add", "README.md"]);
  run(["commit", "-qm", "initial"]);
}
