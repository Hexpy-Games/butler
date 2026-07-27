import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppStoreKernel } from
  "../../packages/butler-agent/src/gateways/app/application/kernel/app-store-kernel.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a late terminal event re-enqueues retention through the App event store", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-retention-integration-"));
  roots.push(root);
  const kernel = new AppStoreKernel({
    butlerData: join(root, "data"),
    butlerHome: root,
    dbPath: join(root, "app.sqlite"),
  });
  const now = new Date().toISOString();
  try {
    kernel.db.query(`
      INSERT INTO chats (id, title, kind, created_at, updated_at)
      VALUES ('chat-late', 'Late retention', 'chat', ?, ?)
    `).run(now, now);
    kernel.db.query(`
      INSERT INTO turns (
        id, chat_id, state, safe_status_label, retryable, cancellable,
        attempt, created_at, updated_at
      ) VALUES ('turn-late', 'chat-late', 'running', 'Working', 0, 1, 1, ?, ?)
    `).run(now, now);
    kernel.appendEvent("progress.summary", progressPayload("initial"));
    appendReplayTail(kernel, 0);
    kernel.db.query(`
      UPDATE turns SET state = 'delivered', cancellable = 0
      WHERE id = 'turn-late'
    `).run();
    kernel.appendEvent("turn.state_changed", {
      turn: { id: "turn-late", state: "delivered" },
    });
    await waitUntil(() => reconstructibleEventCount(kernel) === 0);

    const priorHighWater = retainedHighWater(kernel);
    kernel.appendEvent("progress.summary", progressPayload("late"));
    await waitUntil(
      () => reconstructibleEventCount(kernel) === 1 &&
        retainedHighWater(kernel) > priorHighWater,
    );
    appendReplayTail(kernel, 1_000);
    await waitUntil(
      () => reconstructibleEventCount(kernel) === 0 &&
        retainedHighWater(kernel) > priorHighWater,
    );
    const retained = kernel.terminalTurnRetention.read("turn-late");
    expect(retained?.progressRows).toContainEqual(
      expect.objectContaining({ id: "late" }),
    );
  } finally {
    kernel.close();
  }
});

test("a completed transport cycle wakes a BTCC-settled dormant App turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-retention-settlement-"));
  roots.push(root);
  const data = join(root, "data");
  const kernel = new AppStoreKernel({
    butlerData: data,
    butlerHome: root,
    dbPath: join(root, "app.sqlite"),
  });
  const now = new Date().toISOString();
  try {
    await waitUntil(() => retentionQueueIdle(kernel));
    kernel.db.exec(BTCC_SUCCESSOR_SCHEMA);
    kernel.db.query(`
      INSERT INTO chats (id, title, kind, created_at, updated_at)
      VALUES ('chat-settle', 'Settlement', 'chat', ?, ?)
    `).run(now, now);
    kernel.db.query(`
      INSERT INTO turns (
        id, chat_id, state, safe_status_label, retryable, cancellable,
        attempt, created_at, updated_at
      ) VALUES ('turn-settle', 'chat-settle', 'delivered', 'Delivered', 0, 0, 1, ?, ?)
    `).run(now, now);
    kernel.db.query(`
      INSERT INTO btcc_turns (
        turn_id, session_id, inbox_id, trigger_key, original_message_id,
        original_message, admission_snapshot_ref, model_selection_json,
        context_json, continuation_snapshot_json, semantic_state,
        revision, execution_fence
      ) VALUES ('turn-settle', 'chat-settle', 'inbox', 'trigger', 'message',
        'request', 'admission', '{}', '{}', '[]', 'execution', 1, 1)
    `).run();
    kernel.appendEvent("turn.state_changed", {
      turn: { id: "turn-settle", state: "delivered" },
    });
    await waitUntil(() => retentionQueueIdle(kernel));
    expect(kernel.terminalTurnRetention.read("turn-settle")).toBeNull();
    expect(settlementWakeCount(kernel)).toBe(0);

    kernel.db.query(`
      UPDATE btcc_turns
      SET semantic_state = 'delivered', final_disposition = 'completed'
      WHERE turn_id = 'turn-settle'
    `).run();
    expect(settlementWakeCount(kernel)).toBe(1);
    appendFileSync(join(data, "transcripts", "semantic-wake.jsonl"), "\n");
    await waitUntil(
      () => kernel.terminalTurnRetention.read("turn-settle") !== null,
    );
    expect(settlementWakeCount(kernel)).toBe(0);
  } finally {
    kernel.close();
  }
});

function progressPayload(id: string) {
  return {
    session_id: "chat-late",
    turn_id: "turn-late",
    row: {
      id,
      kind: "tool",
      state: "delivered",
      safe_label: `Operation ${id}`,
      created_at: new Date().toISOString(),
    },
  };
}

function appendReplayTail(kernel: AppStoreKernel, offset: number): void {
  for (let index = 0; index < 205; index += 1) {
    kernel.appendEvent("settings.updated", { revision: offset + index });
  }
}

function reconstructibleEventCount(kernel: AppStoreKernel): number {
  return kernel.db.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM events
    WHERE turn_id = 'turn-late'
      AND type IN ('progress.summary', 'agent.turn_event.progress')
  `).get()?.count ?? 0;
}

function retainedHighWater(kernel: AppStoreKernel): number {
  return kernel.terminalTurnRetention.read("turn-late")
    ?.sourceEventHighWater ?? 0;
}

function settlementWakeCount(kernel: AppStoreKernel): number {
  return kernel.db.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM btcc_terminal_settlement_wakes
  `).get()?.count ?? 0;
}

function retentionQueueIdle(kernel: AppStoreKernel): boolean {
  const queue = kernel.terminalTurnRetentionQueue as unknown as {
    semanticPending: Set<string>;
    maintenancePending: Set<string>;
    cursorWaits: Map<string, number>;
    semanticTimer: ReturnType<typeof setTimeout> | null;
    maintenanceTimer: ReturnType<typeof setTimeout> | null;
    sweepCursor: number | null;
  };
  return queue.semanticPending.size === 0 &&
    queue.maintenancePending.size === 0 && queue.cursorWaits.size === 0 &&
    queue.semanticTimer === null && queue.maintenanceTimer === null &&
    queue.sweepCursor === null;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}
