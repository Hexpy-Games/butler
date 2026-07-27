import { expect, test } from "bun:test";
import {
  createProductionSelectedModel,
  type ProviderPhasePrompt,
} from "../../packages/butler-agent/src/agent/btcc/infrastructure/model/index.ts";
import {
  actualIdentity,
  capabilityCatalog,
  emptyContextResolver,
  guidanceReader,
  phaseEnvelope,
  phaseContinuity,
  promptRunner,
} from "./support/btcc-production-selected-model-fixtures.ts";

test("keeps exact Task target authority out of the stable provider vocabulary", async () => {
  let prompt: ProviderPhasePrompt | undefined;
  const model = createProductionSelectedModel({
    context: emptyContextResolver(),
    capabilities: capabilityCatalog([{
      capabilityRef: "workspace:write",
      name: "write_workspace_file",
      description: "Write one accepted workspace target.",
      operationKinds: ["workspace_artifact_action"],
      inputSchema: { type: "object" },
    }]),
    guidance: guidanceReader(),
    promptRunner: promptRunner(async (input) => {
      prompt = input;
      return {
        carrier: {
          kind: "phase_submission",
          submission: { kind: "complete" },
          publicActivity: {
            summary: "허용된 작업 대상을 확인했습니다.",
            rationale: "실행 권한과 계획 범위를 일치시켰습니다.",
            nextStep: "정확한 대상만 실행합니다.",
          },
        },
        actualIdentity: actualIdentity(),
      };
    }),
  });
  const envelope = phaseEnvelope({ emptyContext: true });
  envelope.operationAuthority = {
    observationScopeRefs: [],
    mutation: {
      kind: "workspace_only",
      workspaceRef: { id: "workspace", sha256: "workspace-sha" },
      operationRoot: { kind: "directory", relativeTarget: "." },
      mutationScope: { kind: "contained_paths", writablePaths: ["src/sample.ts"] },
    },
  };

  await model.runRound(envelope);

  const schema = JSON.stringify(prompt?.responseSchema);
  const functions = JSON.stringify(prompt?.carrierFunctions);
  expect(schema).toContain('"relativeTarget":{"type":"string","minLength":1}');
  expect(functions).toContain('"relativeTarget":{"type":"string","minLength":1}');
  expect(schema).not.toContain('"relativeTarget":{"type":"string","enum"');
});

test("rejects an out-of-scope proposal through exact local admission", async () => {
  const workspaceRef = { id: "workspace", sha256: "workspace-sha" };
  const model = createProductionSelectedModel({
    context: emptyContextResolver(),
    capabilities: capabilityCatalog([{
      capabilityRef: "workspace:write",
      name: "write_workspace_file",
      description: "Write one accepted workspace target.",
      operationKinds: ["workspace_artifact_action"],
      inputSchema: { type: "object" },
    }]),
    guidance: guidanceReader(),
    promptRunner: promptRunner(async () => ({
      carrier: {
        kind: "operation_requests",
        phaseContinuity: phaseContinuity(),
        requests: [{
          requestId: "broader-target",
          publicTitle: "Test operation",
          kind: "workspace_artifact_action",
          capabilityRef: "workspace:write",
          relativeTarget: ".",
          input: {},
        }],
      },
      actualIdentity: actualIdentity(),
    })),
  });
  const envelope = phaseEnvelope({ emptyContext: true });
  envelope.operationAuthority = {
    observationScopeRefs: [],
    mutation: {
      kind: "workspace_only",
      workspaceRef,
      operationRoot: { kind: "directory", relativeTarget: "." },
      mutationScope: { kind: "contained_paths", writablePaths: ["src/sample.ts"] },
    },
  };

  expect(await model.runRound(envelope)).toMatchObject({
    kind: "interruption",
    code: "provider_protocol_interruption",
    activation: { kind: "automatic_provider_recovery" },
    diagnostic: {
      schema: "btcc.operational-diagnostic.v1",
      kind: "provider_carrier_rejection",
      path: "$.requests[0].relativeTarget",
      reason: "enum_mismatch",
    },
  });
});
