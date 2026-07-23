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

test("renders only the exact accepted Task targets into the provider schema", async () => {
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
  expect(schema).toContain('"relativeTarget":{"type":"string","enum":["src/sample.ts"]}');
  expect(functions).toContain('"relativeTarget":{"type":"string","enum":["src/sample.ts"]}');
  expect(schema).not.toContain('"relativeTarget":{"type":"string"}');
});

test("admits an out-of-scope target as a rejectable Phase proposal", async () => {
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

  expect(await model.runRound(envelope)).toEqual({
    kind: "operation_requests",
    phaseContinuity: phaseContinuity(),
    requests: [{
      requestId: "broader-target",
      kind: "workspace_artifact_action",
      capabilityRef: "workspace:write",
      workspaceRef,
      relativeTarget: ".",
      input: {},
    }],
    actualIdentity: actualIdentity(),
  });
});
