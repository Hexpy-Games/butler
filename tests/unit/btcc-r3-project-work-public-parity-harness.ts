import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestAppServer } from
  "../../packages/butler-agent/src/test-support/app-server.ts";
import type { InboundEnvelope } from
  "../../packages/butler-agent/src/gateways/core/contracts.ts";
import { NativeInboundQueue } from
  "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import { createProductionBtccComposition } from
  "../../packages/butler-agent/src/agent/composition/create-btcc-composition.ts";
import type {
  ModelRoundPort,
  ModelRoundRequest,
  ModelRoundResult,
} from "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { createBtccGatewayHandlers } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/create-btcc-gateway-handlers.ts";
import { GatewayRouter } from
  "../../packages/butler-agent/src/gateways/core/router.ts";
import { createGatewayServer } from
  "../../packages/butler-agent/src/gateways/core/server.ts";
import { SessionBindingStore } from
  "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { BtccInboundDispatcher } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/index.ts";
import { DeliveryGuard } from
  "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { createAppTransportAdapter } from
  "../../packages/butler-agent/src/interfaces/transport/app/adapter.ts";
import { loadProjectLedgerCore } from
  "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/project-ledger-core.ts";

export type PublicProject = {
  appProjectId: string;
  ledgerProjectId: string;
  sessionId: string;
  workspacePath: string;
};

export type DispatchSummary = {
  claimed: number;
  handled: number;
  delivered: number;
  failed: number;
  interrupted: number;
};

export type ScriptStep =
  | ModelRoundResult
  | ((request: ModelRoundRequest) => ModelRoundResult | Promise<ModelRoundResult>);

export class CapturingModelRound implements ModelRoundPort {
  readonly requests: ModelRoundRequest[] = [];
  readonly toolMessages: Array<{ name?: string; content: string }> = [];
  private index = 0;

  constructor(private readonly steps: ScriptStep[]) {}

  async runRound(request: ModelRoundRequest): Promise<ModelRoundResult> {
    this.requests.push(request);
    for (const message of request.messages) {
      if (message.role !== "tool") continue;
      const seen = this.toolMessages.some((item) =>
        item.name === message.name && item.content === message.content);
      if (!seen) this.toolMessages.push({ name: message.name, content: message.content });
    }
    const step = this.steps[this.index++];
    if (!step) throw new Error("public_parity_model_script_exhausted");
    return await (typeof step === "function" ? step(request) : step);
  }
}

export class PublicParityHarness {
  readonly root: string;
  readonly appDbPath: string;
  readonly queue: NativeInboundQueue;
  private readonly bindingsPath: string;
  private readonly bindings: SessionBindingStore;
  private readonly server: ReturnType<typeof createTestAppServer>;
  private readonly previousOperationResultReplay: string | undefined;
  private messageIndex = 0;
  private ownerIndex = 0;

  constructor(label: string, options: { operationResultReplay?: boolean } = {}) {
    this.previousOperationResultReplay = process.env.BUTLER_OPERATION_RESULT_REPLAY;
    if (options.operationResultReplay) process.env.BUTLER_OPERATION_RESULT_REPLAY = "1";
    this.root = mkdtempSync(join(tmpdir(), `btcc-public-parity-${label}-`));
    this.appDbPath = join(this.root, "app.sqlite");
    this.bindingsPath = join(this.root, "runtime", "session-store.sqlite");
    writeNativeReadiness(this.root);
    this.bindings = new SessionBindingStore(this.bindingsPath, "ephemeral");
    this.server = createTestAppServer({
      dbPath: this.appDbPath,
      butlerData: this.root,
      projectWorkspaceRoot: join(this.root, "workspaces"),
      messageRateLimit: { max: 1_000, windowMs: 60_000 },
      port: 0,
    });
    this.queue = new NativeInboundQueue(this.root);
  }

  get appUrl(): string {
    return this.server.url;
  }

  async createProject(input: {
    displayName: string;
    ledgerProjectId: string;
    title?: string;
  }): Promise<PublicProject> {
    const project = await postJson(`${this.server.url}projects`, {
      source: "scratch",
      display_name: input.displayName,
    });
    const appProjectId = String(project.data.project.id);
    const db = new Database(this.appDbPath);
    let workspacePath: string;
    try {
      db.query("UPDATE projects SET ledger_project_id = ? WHERE id = ?")
        .run(input.ledgerProjectId, appProjectId);
      workspacePath = db.query<{ workspace_path: string }, [string]>(
        "SELECT workspace_path FROM projects WHERE id = ?",
      ).get(appProjectId)!.workspace_path;
    } finally {
      db.close(false);
    }
    writeFileSync(join(workspacePath, "public-fact.txt"), "public parity fact\n");
    const sessionId = await this.createProjectSession(
      appProjectId,
      input.title ?? input.displayName,
    );
    return {
      appProjectId,
      ledgerProjectId: input.ledgerProjectId,
      sessionId,
      workspacePath,
    };
  }

  async createProjectSession(appProjectId: string, title: string): Promise<string> {
    const session = await postJson(`${this.server.url}sessions`, {
      kind: "project",
      project_id: appProjectId,
      title,
    });
    return String(session.data.session.id);
  }

  setSessionProject(sessionId: string, projectId: string | null): void {
    const db = new Database(this.appDbPath);
    try {
      db.query("UPDATE chats SET project_id = ? WHERE id = ?").run(projectId, sessionId);
    } finally {
      db.close(false);
    }
  }

  forgetGuidedToolCall(turnId: string, toolName: string): string {
    const db = this.runtimeDb();
    try {
      const row = db.query<{ call_id: string; turn_id: string }, [string]>(`
        SELECT call_id, turn_id FROM btcc_guided_tool_calls
        WHERE tool_name = ? ORDER BY rowid DESC LIMIT 1
      `).get(toolName);
      if (!row) throw new Error(`public_parity_guided_call_missing:${toolName}`);
      if (row.turn_id !== turnId) {
        throw new Error(`public_parity_guided_turn_mismatch:${row.turn_id}:${turnId}`);
      }
      db.query("DELETE FROM btcc_guided_tool_calls WHERE call_id = ?").run(row.call_id);
      return row.call_id;
    } finally {
      db.close(false);
    }
  }

  tamperProjectOccurrenceRequest(operationId: string): void {
    const directory = join(
      this.root,
      "runtime",
      "btcc-project-ledger-effects-v2",
      "occurrences",
    );
    const path = readdirSync(directory).map((name) => join(directory, name)).find((candidate) => {
      const occurrence = JSON.parse(readFileSync(candidate, "utf8")) as {
        operationIdentity?: { id?: string };
      };
      return occurrence.operationIdentity?.id === operationId;
    });
    if (!path) throw new Error(`public_parity_occurrence_missing:${operationId}`);
    const occurrence = JSON.parse(readFileSync(path, "utf8")) as {
      attempts: Array<{ requestSha256: string }>;
    };
    occurrence.attempts[0]!.requestSha256 = "0".repeat(64);
    writeFileSync(path, `${JSON.stringify(occurrence)}\n`);
  }

  appDb(): Database {
    return new Database(this.appDbPath);
  }

  runtimeDb(options: { readonly?: boolean } = {}): Database {
    const path = join(this.root, "agent-runtime", "btcc.sqlite");
    return options.readonly ? new Database(path, { readonly: true }) : new Database(path);
  }

  ledgerRoot(ledgerProjectId: string): string {
    return join(this.root, "project-ledger", "projects", ledgerProjectId);
  }

  async postMessage(input: {
    chatId: string;
    text: string;
    clientId?: string;
  }): Promise<{ response: Response; body: any; envelope: InboundEnvelope }> {
    this.messageIndex += 1;
    const response = await fetch(`${this.server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: input.chatId,
        text: input.text,
        model: "openai/gpt-5.6-sol",
        reasoning_effort: "medium",
        access_mode: "full_access",
        client_message_id: input.clientId ??
          `public-parity-${this.messageIndex}-aaaa-4aaa-8aaa-${String(this.messageIndex).padStart(12, "0")}`,
      }),
    });
    const body = await response.clone().json();
    let envelope: InboundEnvelope | undefined;
    for (let attempt = 0; attempt < 100 && !envelope; attempt += 1) {
      envelope = this.pendingEnvelopes().at(-1);
      if (!envelope) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!envelope) {
      throw new Error(
        `public_parity_pending_envelope_missing:${response.status}:${JSON.stringify(body)}`,
      );
    }
    return { response, body, envelope };
  }

  async dispatch(modelRound: ModelRoundPort, options: {
    limit?: number;
    maxConcurrentSessions?: number;
  } = {}): Promise<DispatchSummary> {
    this.ownerIndex += 1;
    const composition = createProductionBtccComposition({
      butlerHome: process.cwd(),
      butlerData: this.root,
      ownerId: `public-parity-${this.ownerIndex}`,
      sessionBindings: this.bindings,
      modelRound,
    });
    try {
      await composition.ready;
      const gateway = createGatewayServer({
        router: new GatewayRouter({ store: this.bindings }),
        handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
        butlerData: this.root,
      });
      const dispatcher = new BtccInboundDispatcher();
      let summary: DispatchSummary = {
        claimed: 0,
        handled: 0,
        delivered: 0,
        failed: 0,
        interrupted: 0,
      };
      for (let attempt = 0; attempt < 30 && summary.claimed === 0; attempt += 1) {
        summary = dispatcher.poll({
          queue: this.queue,
          server: gateway,
          store: this.bindings,
          deliveryGuard: new DeliveryGuard({
            adapters: [createAppTransportAdapter()],
            butlerData: this.root,
          }),
          limit: options.limit ?? 1,
          maxConcurrentSessions: options.maxConcurrentSessions ?? 1,
        });
        await dispatcher.waitForIdle();
        if (summary.claimed === 0) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      return summary;
    } finally {
      await composition.host.close();
    }
  }

  async runTurn(input: {
    chatId: string;
    text: string;
    steps: ScriptStep[];
    clientId?: string;
    beforeDispatch?: (envelope: InboundEnvelope) => void | Promise<void>;
  }): Promise<{
    accepted: { response: Response; body: any; envelope: InboundEnvelope };
    model: CapturingModelRound;
    summary: DispatchSummary;
  }> {
    const accepted = await this.postMessage(input);
    expect(accepted.response.status).toBe(202);
    await input.beforeDispatch?.(accepted.envelope);
    const model = new CapturingModelRound(input.steps);
    const summary = await this.dispatch(model);
    return { accepted, model, summary };
  }

  pendingEnvelopes(): InboundEnvelope[] {
    const pending = join(this.queue.rootDir, "pending");
    if (!existsSync(pending)) return [];
    return readdirSync(pending).sort().map((name) => {
      const row = JSON.parse(readFileSync(join(pending, name), "utf8")) as {
        envelope: InboundEnvelope;
      };
      return row.envelope;
    });
  }

  queueRecords(state: "pending" | "processing" | "processed" | "failed") {
    const directory = join(this.queue.rootDir, state);
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter((name) => name.endsWith(".json")).sort().map((name) =>
      JSON.parse(readFileSync(join(directory, name), "utf8")) as Record<string, any>,
    );
  }

  close(): void {
    this.server.stop();
    this.bindings.close();
    rmSync(this.root, { recursive: true, force: true });
    if (this.previousOperationResultReplay === undefined) {
      delete process.env.BUTLER_OPERATION_RESULT_REPLAY;
    } else {
      process.env.BUTLER_OPERATION_RESULT_REPLAY = this.previousOperationResultReplay;
    }
  }
}

export function tool(
  id: string,
  name: string,
  arguments_: Record<string, unknown>,
): ModelRoundResult {
  return toolBatch([{ id, name, arguments: arguments_ }]);
}

export function toolBatch(calls: Array<{
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}>): ModelRoundResult {
  return {
    toolCalls: calls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      rawArguments: JSON.stringify(call.arguments),
    })),
  };
}

export function finalText(text = "Public parity turn complete."): ModelRoundResult {
  return { text, toolCalls: [] };
}

export function latestToolPayload(
  request: ModelRoundRequest,
  name?: string,
): Record<string, any> {
  const message = request.messages.filter((item) =>
    item.role === "tool" && (!name || item.name === name)).at(-1);
  if (!message) throw new Error(`public_parity_tool_result_missing:${name ?? "any"}`);
  return JSON.parse(message.content) as Record<string, any>;
}

export function workIdFrom(request: ModelRoundRequest, name?: string): string {
  const payload = latestToolPayload(request, name);
  const workId = payload.output?.work?.work_id ?? payload.work?.work_id;
  if (typeof workId !== "string" || !workId) {
    throw new Error(`public_parity_work_id_missing:${name ?? "any"}`);
  }
  return workId;
}

export function turnIdFrom(body: any): string {
  const id = body?.data?.turn?.id;
  if (typeof id !== "string" || !id) throw new Error("public_parity_turn_id_missing");
  return id;
}

export async function inspectOfficialWork(ledgerRoot: string, workId?: string) {
  const core = await loadProjectLedgerCore();
  const index = core.buildIndex(ledgerRoot);
  const records = index.records as Array<(typeof index.records)[number] & {
    parentId?: string;
  }>;
  const workRecord = records.find((record) =>
    record.kind === "work" && (!workId || record.id === workId));
  if (!workRecord) throw new Error("public_parity_official_work_missing");
  const workPath = core.projectPath(ledgerRoot, workRecord.path);
  const manifest = JSON.parse(core.readRecordBody(workPath) ?? "null") as Record<string, any>;
  const children = records.filter((record) => record.parentId === workRecord.id);
  const childBodies = children.map((record) => ({
    record,
    body: JSON.parse(core.readRecordBody(
      core.projectPath(ledgerRoot, record.path),
    ) ?? "null") as Record<string, any>,
  }));
  const countSchema = (fragment: string) => childBodies.filter(({ body }) =>
    String(body.schema).includes(fragment)).length;
  return {
    core,
    index,
    workRecord,
    manifest,
    children: childBodies,
    workId: workRecord.id,
    officialStatus: workRecord.status,
    semanticStatus: manifest.status ?? manifest.work?.status,
    planCount: countSchema("project-work-plan"),
    checkpointCount: countSchema("project-work-checkpoint"),
    resultCount: countSchema("project-work-result-reference"),
    reviewCount: countSchema("project-work-review"),
    dispositionCount: countSchema("project-work-disposition"),
    bindingCount: countSchema("project-work-binding"),
    closeoutCount: countSchema("closeout-diagnostic"),
    abandonmentCount: new Set(childBodies.filter(({ body }) =>
      body.operationIdentity?.kind === "abandonment",
    ).map(({ body }) => body.operationIdentity.id)).size,
    legacyImportCount: new Set(childBodies.filter(({ body }) =>
      body.operationIdentity?.kind === "legacy_import",
    ).map(({ body }) => body.operationIdentity.id)).size,
  };
}

export function semanticRowCounts(db: Database) {
  const count = (table: string) => db.query<{ count: number }, []>(
    `SELECT COUNT(*) AS count FROM ${table}`,
  ).get()?.count ?? 0;
  return {
    works: count("btcc_guided_works"),
    plans: count("btcc_guided_work_plan_revisions"),
    checkpoints: count("btcc_guided_work_checkpoint_revisions"),
    reviews: count("btcc_guided_work_review_revisions"),
    dispositions: count("btcc_guided_work_disposition_revisions"),
    results: count("btcc_guided_work_results"),
    bindings: count("btcc_guided_turn_work_bindings"),
    legacyImports: count("btcc_guided_work_legacy_imports"),
  };
}

export function guidedToolRows(db: Database): Array<{
  call_id: string;
  turn_id: string;
  tool_name: string;
  result_json: string | null;
  result_sha256: string | null;
}> {
  return db.query<{
    call_id: string;
    turn_id: string;
    tool_name: string;
    result_json: string | null;
    result_sha256: string | null;
  }, []>(`
    SELECT call_id, turn_id, tool_name, result_json, result_sha256
    FROM btcc_guided_tool_calls ORDER BY rowid
  `).all();
}

async function postJson(url: string, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return await response.json();
}

function writeNativeReadiness(root: string): void {
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "eol.md"), "Preserve exact reviewed public parity evidence.\n");
  writeFileSync(
    join(root, "state", "butler-main-native.json"),
    JSON.stringify({
      pid: process.pid,
      startedAt: "2026-08-25T13:00:00.000Z",
      runtime: "codex-api",
      launcher: "start-butler.sh",
    }),
  );
}
