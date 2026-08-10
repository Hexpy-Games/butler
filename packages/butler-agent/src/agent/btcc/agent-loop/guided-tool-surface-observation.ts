import type { ButlerExecutionPolicy } from "../contracts.ts";
import type { TurnRecord } from "../turn/index.ts";
import type { WorkspaceReference } from "../../session-workspaces/index.ts";
import { M1_MINIMAL_TOOL_SURFACE_FLAG_REVISION } from
  "../../tools/m1-minimal-tool-surface.ts";
import { workspacePagePreviewAvailabilityOverride } from
  "../../tools/workspace-page-preview/index.ts";
import type { FunctionToolDefinition } from
  "../../../integrations/providers/runtime-contracts.ts";
import { parseModelRef } from
  "../../../integrations/providers/model-ref.ts";
import { modelFacingFunctionTools } from
  "../../../integrations/providers/shared/tools.ts";
import {
  createM1ToolSurfaceAdmissionRecorder,
  hashM1ToolSurfaceAuthority,
  hashM1ToolSurfaceAvailability,
  hashM1ToolSurfaceSchema,
  m1ToolSurfaceSchemaByteLength,
  type M1ToolSurfaceAdmissionStatus,
} from "../../../operations/metrics/m1-tool-surface-admission.ts";
import { GUIDED_NATIVE_TOOL_AVAILABILITY_OVERRIDES } from
  "./guided-turn-policy.ts";

export interface GuidedToolSurfaceObservation {
  observeProviderTools(tools: readonly FunctionToolDefinition[]): void;
  finalize(status: M1ToolSurfaceAdmissionStatus): void;
}

export function createGuidedToolSurfaceObservation(input: {
  butlerData: string;
  modelRef: string;
  policy: ButlerExecutionPolicy;
  turn: TurnRecord;
  workspaceReference: WorkspaceReference;
}): GuidedToolSurfaceObservation {
  const activeModel = parseModelRef(input.modelRef);
  const recorder = createM1ToolSurfaceAdmissionRecorder({
    butlerData: input.butlerData,
    metadata: {
      phaseId: "guided",
      policyRevision: input.turn.modelSelection.controlsHash,
      authorityDigest: hashM1ToolSurfaceAuthority({
        role: input.policy.role,
        accessMode: input.policy.accessMode,
        trackingMode: input.policy.trackingMode,
        hasProject: Boolean(input.policy.projectId || input.turn.context.projectRef),
        workspaceAvailable: workspaceAvailable(input.workspaceReference),
        requiredProfiles: [...input.policy.requiredNativeToolProfiles]
          .sort().join(","),
        requiredTools: [...input.policy.requiredNativeTools].sort().join(","),
      }),
      providerId: activeModel.providerId,
      modelRef: activeModel.canonicalRef,
      dynamicAvailabilityHash: hashM1ToolSurfaceAvailability({
        disabledToolNames: Object.keys(GUIDED_NATIVE_TOOL_AVAILABILITY_OVERRIDES),
        pagePreviewAvailable: !workspacePagePreviewAvailabilityOverride(process.env),
      }),
      flagRevision: M1_MINIMAL_TOOL_SURFACE_FLAG_REVISION,
    },
  });
  return {
    observeProviderTools(tools) {
      const carrier = modelFacingFunctionTools(tools);
      const schemaByteLength = m1ToolSurfaceSchemaByteLength(carrier);
      recorder.observe({
        selectedToolCount: carrier.length,
        schemaByteLength,
        tokenEstimate: Math.ceil(schemaByteLength / 4),
        stableSchemaHash: hashM1ToolSurfaceSchema(carrier),
      });
      recorder.finalize("ok");
    },
    finalize: recorder.finalize,
  };
}

function workspaceAvailable(reference: WorkspaceReference): boolean {
  try {
    return reference.get().trim().length > 0;
  } catch {
    return false;
  }
}
