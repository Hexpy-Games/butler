import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBtccSqliteStores } from "../../packages/butler-agent/src/agent/adapters/index.ts";
import { createGuidedOperationResultRuntime } from "../../packages/butler-agent/src/agent/btcc/operation-result-replay/guided-runtime.ts";
import { createReadOperationResultsHandler } from "../../packages/butler-agent/src/agent/tools/monitoring/read_operation_results/executor.ts";

test("journal discovery keeps a frozen cursor and returns readable original requests/results in the bound Turn", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-history-test-"));
  const stores = openBtccSqliteStores({ dbPath: join(root, "btcc.sqlite"), ownerId: "history" });
  try {
    const record = (turnId: string, id: string, text: string) => {
      stores.guidedToolJournal.start({ turnId, callId: id, toolName: "run_command", rawArguments: JSON.stringify({ command: text, original_only: true }), arguments: { command: text } });
      stores.guidedToolJournal.finish({ callId: id, status: "completed", result: { ok: false, error: { message: `failure ${text}` } } });
    };
    record("t", "a", "inspect parser first"); record("t", "b", "inspect parser second");
    record("other", "private", "other private parser");
    const runtime = createGuidedOperationResultRuntime({ mode: "disabled", exactReadCapability: true,
      turnId: "t", turnRevision: 1, sessionId: "s", journal: stores.guidedToolJournal, exactReader: stores.guidedOperationResultReader });
    const handlers = createReadOperationResultsHandler(runtime.read!);
    expect(handlers.list_operation_results).toBeDefined();
    const first = runtime.read!({ __list: true, query: "parser", limit: 1, cursor: 0, through: null, status: null }) as any;
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0].request_preview).toContain("first");
    record("t", "later", "inspect parser later");
    const second = runtime.read!({ __list: true, query: "parser", limit: 1, cursor: first.next_cursor, through: first.through }) as any;
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0].request_preview).toContain("second");
    expect(second.next_cursor).toBeNull();
    const args = first.entries[0].exact_read;
    const request = runtime.read!({ ...args, source: "request" }) as any;
    expect(JSON.parse(Buffer.from(request.data, "base64").toString())).toEqual({ command: "inspect parser first", original_only: true });
    const result = runtime.read!({ ...args, source: "result" }) as any;
    expect(JSON.parse(Buffer.from(result.data, "base64").toString()).error.message).toBe("failure inspect parser first");
    expect(() => runtime.read!({ ...args, result_ref: "private" })).toThrow("scope_mismatch");
  } finally { stores.close(); rmSync(root, { recursive: true, force: true }); }
});
