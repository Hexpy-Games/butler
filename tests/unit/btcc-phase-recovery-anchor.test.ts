import { expect, test } from "bun:test";
import {
  objectSchema,
  runPhaseConversation,
  type PhaseConversationStore,
  type PhaseRunBinding,
} from "../../packages/butler-agent/src/agent/btcc/core/index.ts";

test("phase recovery uses the latest durable checkpoint revision", async () => {
  const initial = binding(1);
  const durable = binding(2);
  let current = initial;
  const store: PhaseConversationStore = {
    async restore<Product>() {
      return {
        binding: current,
        acceptedProduct: null as Product | null,
        operationResults: [],
      };
    },
    async appendOperationRound() {
      current = durable;
      return current;
    },
    async appendOperationResults() {
      throw new Error("operation result must not be appended");
    },
    async appendPhaseSubmission() {
      throw new Error("submission must not be appended");
    },
    async acceptPhaseProduct() {
      throw new Error("product must not be accepted");
    },
  };
  const contention = Object.assign(new Error("database is locked"), {
    name: "SQLiteError",
    code: "SQLITE_BUSY",
  });

  const run = runPhaseConversation({
    binding: initial,
    modelSelection: identity,
    context: {
      originalMessageId: "message-1",
      originalMessage: "inspect the workspace",
      sessionId: "session-1",
      userRef: "user-1",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: ["workspace:/repo"],
    },
    phaseContract: {
      phase: "conception_deliberation",
      operationSurface: "authorized",
      objective: "recover_latest_durable_checkpoint",
      duties: [],
      prohibitions: [],
    },
    codec: { submissionSchema: objectSchema({}), decode: (value) => value },
    store,
    model: {
      async runRound() {
        return {
          kind: "operation_requests",
          requests: [
            {
              requestId: "read-1",
              publicTitle: "Test operation",
              kind: "observe",
              capabilityRef: "read_file",
              scopeRef: "workspace:/repo",
              input: { path: "README.md" },
            },
          ],
          actualIdentity: identity,
        };
      },
    },
    operations: {
      perform: async () => {
        throw contention;
      },
    },
    operationAuthority: {
      observationScopeRefs: ["workspace:/repo"],
      mutation: { kind: "forbidden" },
    },
    executionPermit: {
      signal: new AbortController().signal,
      assertActive() {},
      close() {},
    },
  });

  await expect(run).rejects.toMatchObject({
    code: "sqlite_write_contention",
    anchor: durable,
  });
});

const identity = {
  provider: "openai",
  model: "gpt-5.6-sol",
  reasoningEffort: "low" as const,
  controls: { reasoningEffort: "low" },
  controlsHash: "controls-sha",
};

function binding(checkpointRevision: number): PhaseRunBinding {
  return {
    turnId: "turn-1",
    turnRevision: 4,
    semanticState: "conception_deliberation",
    checkpointId: "checkpoint-1",
    checkpointRevision,
    claimId: "claim-1",
    executionFence: 7,
  };
}
