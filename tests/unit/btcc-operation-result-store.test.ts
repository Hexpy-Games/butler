import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
