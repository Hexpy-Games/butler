import { expect, test } from "bun:test";
import {
  normalizeStrictTransportSchema,
  restoreTransportOmissions,
} from "../../packages/butler-agent/src/agent/btcc/infrastructure/model/strict-json-schema.ts";
import {
  providerCarrierAdmissionSchema,
  providerCarrierSchema,
} from "../../packages/butler-agent/src/agent/btcc/infrastructure/model/provider-carrier-schema.ts";
import {
  literalSchema,
  objectSchema,
  textSchema,
} from "../../packages/butler-agent/src/agent/btcc/core/submission-schema.ts";
import { validateJsonObjectSchema } from "../../packages/butler-agent/src/agent/tools/tool-bridge/schema-validation.ts";
import type {
  AvailablePhaseCapability,
} from "../../packages/butler-agent/src/agent/btcc/infrastructure/model/contracts.ts";
import type { OperationAuthority } from "../../packages/butler-agent/src/agent/btcc/core/contracts.ts";

test("strict transport schema makes every object property required and nullable when optional", () => {
  const schema = normalizeStrictTransportSchema({
    type: "object",
    properties: {
      request: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "integer" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    required: ["request"],
    additionalProperties: false,
  });

  expect(schema.required).toEqual(["request"]);
  const request = (schema.properties as Record<string, any>).request;
  expect(request.required).toEqual(["path", "start_line"]);
  expect(request.properties.start_line).toEqual({
    anyOf: [{ type: "integer" }, { type: "null" }],
  });
});

test("strict transport restoration removes only object null placeholders", () => {
  expect(restoreTransportOmissions({
    request: { path: "README.md", start_line: null },
    values: ["kept", null],
  })).toEqual({
    request: { path: "README.md" },
    values: ["kept", null],
  });
});

test("strict transport schema closes property-free object inputs", () => {
  expect(normalizeStrictTransportSchema({
    type: "object",
    additionalProperties: false,
  })).toEqual({
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  });
});

test("strict transport keeps carrier unions satisfiable and admission-equivalent", () => {
  const submissionSchema = objectSchema({
    kind: literalSchema("sample_submission"),
    summary: textSchema(),
  });
  const capability = {
    capabilityRef: "observe.workspace",
    name: "Observe workspace",
    description: "Read an admitted workspace scope.",
    operationKind: "observe",
    inputSchema: objectSchema({ query: textSchema() }),
    observationScopeRefs: ["workspace"],
  } as AvailablePhaseCapability;
  const authority = {} as OperationAuthority;
  const carrierSchema = providerCarrierSchema(
    [capability],
    submissionSchema,
    authority,
  );
  const admissionSchema = providerCarrierAdmissionSchema(
    [capability],
    submissionSchema,
  );
  const normalized = normalizeStrictTransportSchema({
    type: "object",
    properties: { carrier: carrierSchema },
    required: ["carrier"],
    additionalProperties: false,
  });
  const normalizedCarrier = (normalized.properties as Record<string, unknown>).carrier;

  expect(normalizedCarrier).not.toHaveProperty("type");
  expect(normalizedCarrier).not.toHaveProperty("properties");
  expect(normalizedCarrier).not.toHaveProperty("additionalProperties");
  for (const variant of (normalizedCarrier as { anyOf: Record<string, unknown>[] }).anyOf) {
    expect(variant.type).toBe("object");
    expect(variant.additionalProperties).toBe(false);
  }

  const submissionWitness = {
    kind: "phase_submission",
    submission: { kind: "sample_submission", summary: "done" },
    publicActivity: {
      summary: "현재 단계 산출물을 완성했습니다.",
      rationale: "단계 계약을 충족하는 결과를 만들었습니다.",
      nextStep: "다음 단계가 결과를 이어받습니다.",
    },
  };
  const operationWitness = {
    kind: "operation_requests",
    phaseContinuity: {
      objectiveState: "Inspect the admitted workspace.",
      decisions: [],
      unresolved: ["The current status is unknown."],
      nextOperationPurpose: "Read the current status.",
      publicActivity: {
        summary: "현재 작업 상태를 확인하고 있습니다.",
        rationale: "다음 판단을 현재 상태에 근거하기 위해 필요합니다.",
        nextStep: "확인 결과를 바탕으로 단계 산출물을 작성합니다.",
      },
    },
    requests: [{
      requestId: "request-1",
      kind: "observe",
      capabilityRef: "observe.workspace",
      input: { query: "status" },
      scopeRef: "workspace",
    }],
  };

  expect(validateJsonObjectSchema({ carrier: submissionWitness }, normalized).ok).toBe(true);
  expect(validateJsonObjectSchema({ carrier: operationWitness }, normalized).ok).toBe(true);
  expect(validateJsonObjectSchema(submissionWitness, admissionSchema).ok).toBe(true);
  expect(validateJsonObjectSchema(operationWitness, admissionSchema).ok).toBe(true);
  expect(validateJsonObjectSchema({
    ...submissionWitness,
    requests: operationWitness.requests,
  }, admissionSchema).ok).toBe(false);
});
