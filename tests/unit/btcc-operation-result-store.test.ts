import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SqliteOperationResultStore } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/operation-result/index.ts";
import type {
  OperationRequest,
  PhaseRunBinding,
} from "../../packages/butler-agent/src/agent/btcc/core/index.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("BTCC operation result store", () => {
  test("keeps a large result exact while projecting and reading bounded ranges", async () => {
    const root = temporaryRoot();
    const store = new SqliteOperationResultStore(root);
    const request = observationRequest();
    const marker = "EXACT-MIDDLE-RANGE";
    const content = `${"a".repeat(70_000)}${marker}${"z".repeat(70_000)}`;

    const projection = await store.record({
      binding: binding(),
      request,
      result: {
        requestId: request.requestId,
        outcome: "observed",
        observationRef: { id: "observation:large", sha256: "observation-large" },
        content,
      },
      modelSelection: modelSelection(),
    });

    expect(projection.preview.length).toBeLessThan(content.length);
    expect(projection.omittedBytes).toBeGreaterThan(0);
    expect(JSON.stringify(projection)).not.toContain(marker);

    const view = await store.read({
      request: {
        requestId: "read-middle",
        kind: "observe",
        capabilityRef: "read_operation_result",
        scopeRef: projection.readScopeRef,
        input: {
          selector: "bytes",
          start: 69_995,
          length: marker.length + 10,
        },
      },
      modelSelection: modelSelection(),
    });
    expect(view.resultRef).toEqual(projection.resultRef);
    expect(view.view?.content).toContain(marker);
    expect(view.preview).toBe("");

    const payloadRoot = join(
      root,
      "runtime",
      "btcc",
      "result-payloads",
    );
    const payloads = readdirSync(payloadRoot);
    expect(payloads).toHaveLength(1);
    expect(readFileSync(join(payloadRoot, payloads[0]!), "utf8")).toBe(content);
    const database = new Database(
      join(root, "runtime", "btcc", "operation-results.sqlite"),
      { readonly: true },
    );
    expect(database.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM btcc_operation_results",
    ).get()?.count).toBe(1);
    database.close();
    store.close();
  });

  test("reopens a stored request by exact round identity without reproducing it", async () => {
    const root = temporaryRoot();
    const first = new SqliteOperationResultStore(root);
    const request = observationRequest();
    const recorded = await first.record({
      binding: binding(),
      request,
      result: {
        requestId: request.requestId,
        outcome: "observed",
        observationRef: { id: "observation:restart", sha256: "observation-restart" },
        content: "durable result",
      },
      modelSelection: modelSelection(),
    });
    first.close();

    const reopened = new SqliteOperationResultStore(root);
    const found = await reopened.find({
      binding: binding(),
      request,
      modelSelection: modelSelection(),
    });
    expect(found?.resultRef).toEqual(recorded.resultRef);
    expect(found?.preview).toBe("durable result");
    reopened.close();
  });

  test("retains typed command completion without rereading the payload", async () => {
    const root = temporaryRoot();
    const payloadPath = join(root, "command-output.txt");
    const payload = `${JSON.stringify({ exitCode: 0 })}\n--- stdout ---\npassed\n--- stderr ---\n`;
    writeFileSync(payloadPath, payload);
    const store = new SqliteOperationResultStore(root);
    const request = observationRequest();
    const executionSummary = {
      kind: "command_execution" as const,
      exitCode: 0,
      timedOut: false,
      signal: null,
    };

    const recorded = await store.record({
      binding: binding(),
      request,
      result: {
        requestId: request.requestId,
        outcome: "observed",
        observationRef: { id: "observation:command", sha256: "command" },
        content: JSON.stringify({ exitCode: 0, timedOut: false, signal: null }),
        payloadSource: {
          kind: "spooled_text",
          path: payloadPath,
          sha256: sha256(payload),
          byteLength: Buffer.byteLength(payload),
          mediaType: "text/plain; charset=utf-8",
        },
        executionSummary,
      },
      modelSelection: modelSelection(),
    });

    expect(recorded.executionSummary).toEqual(executionSummary);
    const found = await store.find({
      binding: binding(),
      request,
      modelSelection: modelSelection(),
    });
    expect(found?.executionSummary).toEqual(executionSummary);
    store.close();
  });

  test("reads durable source request input through the documented JSON root", async () => {
    const root = temporaryRoot();
    const store = new SqliteOperationResultStore(root);
    const request = observationRequest();
    const projection = await store.record({
      binding: binding(),
      request,
      result: {
        requestId: request.requestId,
        outcome: "operation_rejected",
        observationRef: { id: "observation:rejected", sha256: "rejected" },
        content: JSON.stringify({ status: "rejected", code: "stale_revision" }),
      },
      modelSelection: modelSelection(),
    });

    const requestContent = await store.read({
      request: {
        requestId: "recover-source-command",
        kind: "observe",
        capabilityRef: "read_operation_result",
        scopeRef: projection.readScopeRef,
        input: { selector: "json_pointer", pointer: "/request/input/command" },
      },
      modelSelection: modelSelection(),
    });
    const resultCode = await store.read({
      request: {
        requestId: "read-result-code",
        kind: "observe",
        capabilityRef: "read_operation_result",
        scopeRef: projection.readScopeRef,
        input: { selector: "json_pointer", pointer: "/result/code" },
      },
      modelSelection: modelSelection(),
    });

    expect(JSON.parse(requestContent.view?.content ?? "null")).toBe("produce output");
    expect(JSON.parse(resultCode.view?.content ?? "null")).toBe("stale_revision");
    store.close();
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "butler-operation-result-"));
  roots.push(root);
  return root;
}

function binding(): PhaseRunBinding {
  return {
    turnId: "turn-result",
    turnRevision: 2,
    semanticState: "task_execution",
    checkpointId: "checkpoint-result",
    checkpointRevision: 4,
    claimId: "claim-result",
    executionFence: 1,
  };
}

function observationRequest(): Extract<OperationRequest, { kind: "observe" }> {
  return {
    requestId: "observe-large",
    kind: "observe",
    capabilityRef: "run_command",
    scopeRef: "workspace:fixture",
    input: { command: "produce output" },
  };
}

function modelSelection() {
  return {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "low" as const,
    controls: {},
    controlsHash: "controls",
    contextWindowTokens: 200_000,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
