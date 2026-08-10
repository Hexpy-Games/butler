import { createHash } from "node:crypto";
import type { FunctionToolDefinition } from "../../integrations/providers/runtime-contracts.ts";
import { M1_MINIMAL_TOOL_SURFACE_FLAG_REVISION } from "../../agent/tools/m1-minimal-tool-surface.ts";
import { recordOperationalMetric } from "./operational-metrics.ts";

export const M1_TOOL_SURFACE_ADMISSION_EVENT_NAME = "m1_tool_surface_admission" as const;
export const M1_TOOL_SURFACE_ADMISSION_FLAG_REVISION = M1_MINIMAL_TOOL_SURFACE_FLAG_REVISION;

export type M1ToolSurfaceAdmissionStatus = "ok" | "error" | "skipped";

export interface M1ToolSurfaceAdmissionMetadata {
  phaseId: string;
  policyRevision: string;
  authorityDigest: string;
  providerId: string;
  modelRef: string;
  stableSchemaHash?: string | null;
  dynamicAvailabilityHash: string;
  flagRevision: string;
}

export interface M1ToolSurfaceAdmissionMeasurements {
  selectedToolCount?: number | null;
  schemaByteLength?: number | null;
  tokenEstimate?: number | null;
  stableSchemaHash?: string | null;
}

export interface M1ToolSurfaceAdmissionRecorder {
  observe(measurements: M1ToolSurfaceAdmissionMeasurements): void;
  finalize(status: M1ToolSurfaceAdmissionStatus): void;
}

export function createM1ToolSurfaceAdmissionRecorder(input: {
  butlerData?: string;
  env?: Record<string, string | undefined>;
  metadata: M1ToolSurfaceAdmissionMetadata;
}): M1ToolSurfaceAdmissionRecorder {
  let finalized = false;
  let stableSchemaHash = input.metadata.stableSchemaHash ?? null;
  let measurements: Required<M1ToolSurfaceAdmissionMeasurements> = {
    selectedToolCount: null,
    schemaByteLength: null,
    tokenEstimate: null,
    stableSchemaHash: null,
  };

  return {
    observe(next) {
      if (finalized) return;
      measurements = {
        ...measurements,
        selectedToolCount: next.selectedToolCount ?? null,
        schemaByteLength: next.schemaByteLength ?? null,
        tokenEstimate: next.tokenEstimate ?? null,
        stableSchemaHash: next.stableSchemaHash ?? measurements.stableSchemaHash,
      };
      if (next.stableSchemaHash !== undefined) stableSchemaHash = next.stableSchemaHash;
    },
    finalize(status) {
      if (finalized) return;
      finalized = true;
      try {
        recordOperationalMetric({
          category: "tool",
          name: M1_TOOL_SURFACE_ADMISSION_EVENT_NAME,
          status,
          unit: "tools",
          dimensions: {
            phaseId: safeIdentifier(input.metadata.phaseId),
            policyRevision: safeIdentifier(input.metadata.policyRevision),
            authorityDigest: safeDigest(input.metadata.authorityDigest),
            providerId: safeProviderId(input.metadata.providerId),
            modelRef: safeModelRef(input.metadata.modelRef),
            stableSchemaHash: safeDigest(stableSchemaHash),
            dynamicAvailabilityHash: safeDigest(input.metadata.dynamicAvailabilityHash),
            flagRevision: safeIdentifier(input.metadata.flagRevision),
            selectedToolCount: measurements.selectedToolCount,
            schemaByteLength: measurements.schemaByteLength,
            tokenEstimate: measurements.tokenEstimate,
          },
        }, {
          butlerData: input.butlerData,
          env: input.env,
        });
      } catch {
        // Tool-surface telemetry is diagnostic only and must never block a turn.
      }
    },
  };
}

export function hashM1ToolSurfaceAuthority(input: Readonly<Record<string, string | number | boolean | null>>): string {
  return sha256(stableJson(input));
}

export function hashM1ToolSurfaceAvailability(input: {
  disabledToolNames: readonly string[];
  pagePreviewAvailable: boolean;
}): string {
  return sha256(stableJson({
    disabledToolNames: [...input.disabledToolNames].sort(),
    pagePreviewAvailable: input.pagePreviewAvailable,
  }));
}

export function hashM1ToolSurfaceSchema(tools: readonly FunctionToolDefinition[]): string {
  return sha256(JSON.stringify(tools));
}

export function m1ToolSurfaceSchemaByteLength(tools: readonly FunctionToolDefinition[]): number {
  return Buffer.byteLength(JSON.stringify(tools), "utf8");
}

function safeIdentifier(value: string): string | null {
  const trimmed = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(trimmed) ? trimmed : null;
}

const REGISTERED_MODEL_PROVIDERS = new Set([
  "openai", "anthropic", "google", "xai", "qwen", "kimi", "zai", "zai-api",
  "opencode-go", "local",
]);
const CREDENTIAL_OR_PATH_MARKER = /(?:^|[-_.:])(?:sk|pk|rk|api[-_]?key|token|secret|credential|password|private|users?|home|tmp|var|path)(?:$|[-_.:])/iu;

function safeProviderId(value: string): string | null {
  const trimmed = value.trim();
  return REGISTERED_MODEL_PROVIDERS.has(trimmed) ? trimmed : null;
}

function safeModelRef(value: string): string | null {
  const trimmed = value.trim();
  if (!/^[a-z][a-z0-9-]{1,31}\/[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(trimmed)) return null;
  const separator = trimmed.indexOf("/");
  const provider = trimmed.slice(0, separator);
  const model = trimmed.slice(separator + 1);
  return REGISTERED_MODEL_PROVIDERS.has(provider) && !CREDENTIAL_OR_PATH_MARKER.test(model)
    ? trimmed
    : null;
}

function safeDigest(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return /^[a-f0-9]{64}$/.test(trimmed) ? trimmed : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
