import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveWakeResult,
  renderWakeResult,
} from "../../packages/butler-agent/src/interfaces/gateway/btcc/archive-wake-result.ts";
import { admitGatewayCommand } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/admit-gateway-command.ts";
import { SqliteOperationResultStore } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/operation-result/index.ts";
import type {
  InboundEnvelope,
  StoredSessionBinding,
} from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("archives a worker wake result and admits only its bounded projection", async () => {
  const butlerData = temporaryRoot();
  const marker = "EXACT-WORKER-MIDDLE";
  const content = `${"a".repeat(70_000)}${marker}${"z".repeat(70_000)}`;
  const projection = archiveWakeResult({
    butlerData,
    sourceTurnId: "turn-source",
    triggerId: "worker-complete:task-1",
    capabilityRef: "background_worker_completion",
    sourceScopeRef: "worker-task:task-1",
    content,
    contextWindowTokens: 200_000,
  });
  const message = renderWakeResult(projection);

  expect(message).not.toContain(marker);
  expect(message).toContain(projection.readScopeRef);
  const command = admitGatewayCommand({
    binding: sessionBinding(butlerData),
    envelope: wakeEnvelope(message, projection.readScopeRef),
    turnId: "turn-wake",
    context: {
      userRef: "user-1",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [],
    },
  });
  expect(command.kind).toBe("wake");
  if (command.kind !== "wake") throw new Error("expected wake command");
  expect(command.context.baselineObservationScopeRefs).toEqual([
    projection.readScopeRef,
  ]);
  expect(command.trigger.content).toBe(message);

  const store = new SqliteOperationResultStore(butlerData);
  const exact = await store.read({
    request: {
      requestId: "read-worker-middle",
      kind: "observe",
      capabilityRef: "read_operation_result",
      scopeRef: projection.readScopeRef,
      input: { selector: "search", query: marker, max_matches: 1 },
    },
    modelSelection: command.modelSelection,
  });
  expect(exact.view?.content).toContain(marker);
  store.close();
});

function wakeEnvelope(
  message: string,
  resultScopeRef: string,
): InboundEnvelope {
  return {
    eventId: "system:worker-complete:task-1:DONE",
    transport: "system",
    accountId: "local",
    peer: { kind: "dm", id: "butler/main" },
    sender: { id: "worker-monitor" },
    message: {
      id: "worker-complete:task-1",
      text: message,
      timestamp: new Date(0).toISOString(),
    },
    raw: {
      btccWake: {
        triggerId: "worker-complete:task-1",
        sourceTurnId: "turn-source",
        authorizationRef: "worker-task:task-1",
        resultScopeRef,
      },
    },
  };
}

function sessionBinding(workspacePath: string): StoredSessionBinding {
  const timestamp = new Date(0).toISOString();
  return {
    sessionId: "butler/main",
    role: "butler",
    workspacePath,
    runtimeAdapterId: "codex-api",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.6-sol",
    transportBindings: [],
    metadata: { userRef: "user-1", reasoning_effort: "low" },
    lifecycleState: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "btcc-wake-result-"));
  roots.push(root);
  return root;
}
