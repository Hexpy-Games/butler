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
  parseCacheOrderedPrompt,
  phaseEnvelope,
  phaseContinuity,
  promptRunner,
} from "./support/btcc-production-selected-model-fixtures.ts";

test("closed phases disclose terminal effect authority without opening operation rounds", async () => {
  let prompt: ProviderPhasePrompt | undefined;
  const capability = {
    capabilityRef: "profile:update",
    name: "update_profile",
    description: "Update the local profile.",
    operationKinds: ["turn_local_effect" as const],
    inputSchema: {
      type: "object",
      properties: { profiling_mode: { type: "string", enum: ["deep"] } },
      required: ["profiling_mode"],
      additionalProperties: false,
    },
  };
  const model = createProductionSelectedModel({
    context: emptyContextResolver(),
    capabilities: capabilityCatalog([capability]),
    guidance: guidanceReader(),
    promptRunner: promptRunner(async (input) => {
      prompt = input;
      return {
        carrier: {
          kind: "phase_submission",
          submission: { kind: "complete" },
          publicActivity: {
            summary: "프로필 설정을 반영했습니다.",
            rationale: "사용자의 명시적 요청을 적용했습니다.",
            nextStep: "완료 결과를 전달합니다.",
          },
        },
        actualIdentity: actualIdentity(),
      };
    }),
  });
  const envelope = phaseEnvelope({ emptyContext: true });
  envelope.phase = "conception_opening";
  envelope.binding.semanticState = "conception_opening";
  envelope.operationSurface = "closed";
  envelope.operationAuthority = {
    observationScopeRefs: [],
    mutation: {
      kind: "turn_local_effect_only",
      capabilities: [{
        capabilityRef: capability.capabilityRef,
        inputSchema: capability.inputSchema,
      }],
    },
  };

  await model.runRound(envelope);

  const dynamic = parseCacheOrderedPrompt(prompt!.prompt).dynamic;
  expect(dynamic.operationAuthority.mutation.kind).toBe("turn_local_effect_only");
  expect(dynamic.capabilitySchemas).toHaveLength(1);
  expect(dynamic.availableCarrierKinds).toEqual(["phase_submission"]);
  expect(JSON.stringify(prompt?.responseSchema)).not.toContain("operation_requests");
});

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

test("defers target containment to the operation authority boundary", async () => {
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
    kind: "operation_requests",
    requests: [{
      kind: "workspace_artifact_action",
      relativeTarget: ".",
      workspaceRef,
    }],
  });
});
