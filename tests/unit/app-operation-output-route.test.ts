import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteOperationResultStore } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/operation-result/index.ts";
import { createAppServer } from
  "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("app route reads only the requested turn operation output", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-operation-output-route-"));
  roots.push(root);
  const results = new SqliteOperationResultStore(root);
  const projection = await results.record({
    binding: {
      turnId: "turn-output",
      turnRevision: 1,
      semanticState: "task_execution",
      checkpointId: "checkpoint-output",
      checkpointRevision: 1,
      claimId: "claim-output",
      executionFence: 1,
    },
    request: {
      requestId: "request-output",
      publicTitle: "테스트 결과 확인",
      kind: "observe",
      capabilityRef: "run_command",
      scopeRef: "workspace:test",
      input: { command: "test" },
    },
    result: {
      requestId: "request-output",
      outcome: "observed",
      observationRef: { id: "observation:output", sha256: "output" },
      content: "complete output",
    },
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: {},
      controlsHash: "controls",
      contextWindowTokens: 200_000,
    },
  });
  results.close();
  const server = createAppServer({
    butlerData: root,
    dbPath: join(root, "app.sqlite"),
    port: 0,
  });
  try {
    const valid = await fetch(
      `${server.url}turns/turn-output/operations/request-output/output` +
        `?result_id=${encodeURIComponent(projection.resultRef.id)}`,
    );
    expect(valid.status).toBe(200);
    expect((await valid.json()).data).toMatchObject({
      content: "complete output",
      complete: true,
    });
    const foreign = await fetch(
      `${server.url}turns/turn-other/operations/request-output/output` +
        `?result_id=${encodeURIComponent(projection.resultRef.id)}`,
    );
    expect(foreign.status).toBe(404);
  } finally {
    server.stop();
  }
});
