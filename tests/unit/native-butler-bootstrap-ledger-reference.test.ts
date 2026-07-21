import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runNativeButlerMain } from "../../packages/butler-agent/src/interfaces/gateway/native-butler-bootstrap.ts";
import { compileTurnContract, TURN_CONTRACT_DECISION_SCHEMA } from "../../packages/butler-agent/src/agent/turn/turn-contract.ts";
import { TodoListStore } from "../../packages/butler-agent/src/agent/work/todo-list.ts";
import { WorkStreamClaimStore } from "../../packages/butler-agent/src/agent/work/work-stream-claim-store.ts";
import { WorkStreamPlanStore } from "../../packages/butler-agent/src/agent/work/work-stream-plan-store.ts";
import { completeReportingWorkStreamForSession, WorkStreamStore } from "../../packages/butler-agent/src/agent/work/work-stream.ts";
import type { ReportingCompletionJournal } from "../../packages/butler-agent/src/agent/work/work-stream-reporting-store.ts";
import { BOOTSTRAP_RECOVERY_DEADLINE_MS } from "../../packages/butler-agent/src/agent/work/work-stream-transaction-recovery.ts";
import type { ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const provider: ModelProviderAdapter = {
  id: "test-provider",
  capabilities: {
    supportsStreaming: false,
    supportsToolCalls: false,
    supportsImages: false,
    supportsAudio: false,
    supportsServerThreads: false,
    supportsReasoningConfig: true,
    supportsPromptCaching: false,
  },
  async invoke() {
    return { text: "unused" };
  },
};

test("production native bootstrap opens BTCC stores in the App message database", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-bootstrap-ledger-"));
  roots.push(butlerData);
  mkdirSync(join(butlerData, "app-server"), { recursive: true });
  const result = await runNativeButlerMain({
    butlerHome: process.cwd(),
    butlerData,
    provider,
    enableTelegramPolling: false,
    waitForShutdown: false,
  });

  expect(result.shutdownReason).toBe("bootstrap-only");
  const db = new Database(join(butlerData, "app-server", "butler-client.sqlite"), {
    readonly: true,
  });
  try {
    expect(db.query<{ name: string }, []>(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'btcc_turns'
    `).get()?.name).toBe("btcc_turns");
  } finally {
    db.close();
  }
});

test("production native bootstrap reconciles a prepared plan transaction", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-bootstrap-recovery-"));
  roots.push(butlerData);
  const todo = new TodoListStore(butlerData).update({
    listId: "bootstrap-plan",
    items: [
      { id: "done", content: "done", active_form: "Doing done", status: "completed", phase: "planning" },
      { id: "next", content: "next", active_form: "Doing next", status: "in_progress", phase: "execution" },
    ],
  });
  const stream = new WorkStreamStore(butlerData).updateFromTodoList({
    ownerSessionId: "session-bootstrap",
    originChatId: "chat-bootstrap",
    projectId: "project-bootstrap",
    listId: todo.list.list_id,
    items: todo.list.items,
  });
  const contract = compileTurnContract({
    decision: {
      schema_version: TURN_CONTRACT_DECISION_SCHEMA,
      decision_id: "bootstrap-recovery-contract",
      action: "resume_work",
      target_workstream_id: stream.id,
      target_project_id: "project-bootstrap",
      deliverables: ["code_change"],
      public_summary: "Resume bootstrap recovery work.",
    },
    candidates: { workstreams: [{ workstream_id: stream.id, state: stream.state, unsatisfied_obligations: [{ deliverable: "code_change", target_kind: "workspace", target_id: "workspace-bootstrap", generation: 1 }] }] },
  });
  const claimed = new WorkStreamClaimStore(butlerData).claim({
    contract,
    workstreamId: stream.id,
    sessionId: "session-bootstrap",
    chatId: "chat-bootstrap",
    projectId: "project-bootstrap",
    turnId: "turn-bootstrap",
    expectedGeneration: stream.record_generation!,
  });
  if (!claimed.ok) throw new Error("expected bootstrap claim");
  const interrupted = new WorkStreamPlanStore(butlerData).amend({
    workstreamId: stream.id,
    contractId: contract.contract_id,
    expectedGeneration: claimed.record.record_generation!,
    items: [
      { id: "done", content: "done", active_form: "Doing done", status: "completed", phase: "planning" },
      { id: "replacement", content: "replacement", active_form: "Doing replacement", status: "in_progress", phase: "execution" },
    ],
    faultAt: "after_todo_write",
  });
  if (interrupted.ok || !interrupted.transactionId) throw new Error("expected interrupted bootstrap plan");

  await runNativeButlerMain({
    butlerHome: process.cwd(),
    butlerData,
    provider,
    enableTelegramPolling: false,
    waitForShutdown: false,
  });

  expect(new WorkStreamStore(butlerData).read(stream.id)).toMatchObject({ plan_revision: 2 });
  expect(JSON.parse(readFileSync(join(butlerData, "workstream-plan-transactions", `${interrupted.transactionId}.json`), "utf8"))).toMatchObject({ state: "committed" });
});

test("production bootstrap applies one short recovery deadline across many pending journals", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-bootstrap-bounded-recovery-"));
  roots.push(butlerData);
  const todo = new TodoListStore(butlerData).update({
    listId: "bootstrap-reporting",
    items: [
      { id: "done", content: "done", active_form: "Doing done", status: "completed", phase: "execution" },
      { id: "report", content: "report", active_form: "Reporting", status: "in_progress", phase: "reporting" },
    ],
  }).list;
  const stream = new WorkStreamStore(butlerData).updateFromTodoList({
    ownerSessionId: "session-bootstrap-reporting",
    projectId: "project-bootstrap",
    listId: todo.list_id,
    items: todo.items,
  });
  expect(() => completeReportingWorkStreamForSession({
    butlerData,
    sessionId: "session-bootstrap-reporting",
    faultAt: "after_prepare",
  })).toThrow("injected_reporting_completion_fault:after_prepare");
  const journalDir = join(butlerData, "workstream-reporting-transactions");
  const baseName = readdirSync(journalDir).find((name) => name.endsWith(".json"));
  if (!baseName) throw new Error("base reporting journal missing");
  const base = JSON.parse(readFileSync(join(journalDir, baseName), "utf8")) as ReportingCompletionJournal;
  for (let index = 0; index < 2_000; index += 1) {
    const transactionId = `pending-report-${String(index).padStart(4, "0")}`;
    writeFileSync(join(journalDir, `${transactionId}.json`), JSON.stringify({ ...base, transaction_id: transactionId }));
  }

  const startedAt = performance.now();
  const result = await runNativeButlerMain({
    butlerHome: process.cwd(),
    butlerData,
    provider,
    enableTelegramPolling: false,
    waitForShutdown: false,
  });
  const elapsed = performance.now() - startedAt;

  expect(result.shutdownReason).toBe("bootstrap-only");
  expect(elapsed).toBeLessThan(BOOTSTRAP_RECOVERY_DEADLINE_MS + 400);
  const pendingCount = readdirSync(journalDir)
    .map((name) => JSON.parse(readFileSync(join(journalDir, name), "utf8")) as ReportingCompletionJournal)
    .filter((journal) => journal.state === "prepared").length;
  expect(pendingCount).toBeGreaterThan(0);
  expect(new WorkStreamStore(butlerData, { autoRecover: false }).read(stream.id)?.state).toBe("complete");
}, 30_000);
