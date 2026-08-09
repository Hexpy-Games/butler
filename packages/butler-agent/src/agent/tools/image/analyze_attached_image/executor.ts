import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  callMcpTool,
} from "../../../../interfaces/mcp-client/client.ts";
import {
  ZAI_VISION_MCP_SERVER_ID,
  ZAI_VISION_MCP_TOOL_NAME,
  resolveZaiMcpVisionCatalogEntry,
} from "../../../image-attachment/index.ts";
import type {
  ImageCapabilityCatalogEntry,
  ImageCapabilityEvidence,
  ImageCarrierTuple,
  VerifiedImagePayloadPort,
  VisualAdmittedManifest,
} from "../../../image-attachment/contracts.ts";

const MAX_PROMPT_CHARS = 4_000;
const MAX_RESULT_CHARS = 16_000;

export function createAnalyzeAttachedImageToolHandler(input: {
  butlerData: string;
  imageManifests?: readonly VisualAdmittedManifest[];
  imageCarrier?: ImageCarrierTuple;
  imageCapability?: ImageCapabilityEvidence;
  verifiedImagePayloadPort: VerifiedImagePayloadPort;
}) {
  return async (call: { args: Record<string, unknown>; signal?: AbortSignal }) => {
    assertToolCarrier(input.imageCarrier, input.imageCapability);
    const fileId = typeof call.args.file_id === "string" ? call.args.file_id.trim() : "";
    const prompt = typeof call.args.prompt === "string" ? call.args.prompt.trim() : "";
    if (!fileId) throw new Error("analyze_attached_image requires file_id");
    if (!prompt) throw new Error("analyze_attached_image requires prompt");
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error("analyze_attached_image prompt is too long");
    }
    const manifest = (input.imageManifests ?? []).find((candidate) => candidate.fileId === fileId);
    if (!manifest) throw new Error("image_attachment_not_authorized");
    await assertCurrentMcpCarrier({
      butlerData: input.butlerData,
      tuple: input.imageCarrier,
      capability: input.imageCapability,
      signal: call.signal,
    });
    const extension = extensionForMime(manifest.derivativeMimeType);
    const tempRoot = await mkdtemp(join(tmpdir(), "butler-zai-vision-"));
    const tempPath = join(tempRoot, `input${extension}`);
    try {
      const payload = await input.verifiedImagePayloadPort.read(manifest);
      if (payload.mimeType !== manifest.derivativeMimeType ||
          payload.bytes.byteLength !== manifest.derivativeSizeBytes) {
        throw new Error("verified_image_payload_mismatch");
      }
      await writeFile(tempPath, Buffer.from(payload.bytes), { mode: 0o600 });
      const result = await callMcpTool({
        butlerData: input.butlerData,
        serverId: ZAI_VISION_MCP_SERVER_ID,
        toolName: ZAI_VISION_MCP_TOOL_NAME,
        args: {
          image_source: tempPath,
          prompt,
        },
        timeoutMs: 60_000,
        signal: call.signal,
      });
      const text = safeMcpText(result.result, tempRoot, tempPath);
      return {
        ok: true,
        file_id: fileId,
        server_id: ZAI_VISION_MCP_SERVER_ID,
        tool_name: ZAI_VISION_MCP_TOOL_NAME,
        analysis: text,
      };
    } finally {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

async function assertCurrentMcpCarrier(input: {
  butlerData: string;
  tuple: ImageCarrierTuple | undefined;
  capability: ImageCapabilityEvidence | undefined;
  signal?: AbortSignal;
}): Promise<void> {
  const tuple = input.tuple;
  const capability = input.capability;
  if (!tuple || !capability) throw new Error("zai_vision_carrier_unverified");
  const modelRef = `${tuple.providerId}/${tuple.modelId}`;
  const entry: ImageCapabilityCatalogEntry = {
    provider_id: tuple.providerId,
    model_id: tuple.modelId,
    model_ref: modelRef,
    ...(capability.credentialId ? { credential_id: capability.credentialId } : {}),
    runtime_supported: true,
    image_input_verified: true,
    image_capability_revision: tuple.catalogCapabilityRevision,
    image_capability_digest: tuple.catalogCapabilityDigest,
    image_endpoint_profile_id: tuple.endpointProfileId,
    image_carrier_protocol: tuple.carrierProtocol,
    image_tool_server_id: capability.toolServerId,
    image_tool_name: capability.toolName,
    image_tool_capability_digest: capability.toolCapabilityDigest,
  };
  const current = await resolveZaiMcpVisionCatalogEntry({
    entry,
    modelRef,
    butlerData: input.butlerData,
    timeoutMs: 10_000,
    signal: input.signal,
  });
  if (!current || current.image_input_verified !== true ||
      current.image_carrier_protocol !== tuple.carrierProtocol ||
      current.image_endpoint_profile_id !== tuple.endpointProfileId ||
      current.image_capability_revision !== tuple.catalogCapabilityRevision ||
      current.image_capability_digest !== tuple.catalogCapabilityDigest ||
      current.image_tool_server_id !== capability.toolServerId ||
      current.image_tool_name !== capability.toolName ||
      current.image_tool_capability_digest !== capability.toolCapabilityDigest) {
    throw new Error("zai_vision_carrier_changed");
  }
}

function assertToolCarrier(
  tuple: ImageCarrierTuple | undefined,
  capability: ImageCapabilityEvidence | undefined,
): void {
  if (!tuple || tuple.providerId !== "zai" || tuple.modelId !== "glm-5.2" ||
      tuple.carrierProtocol !== "zai_mcp_vision" ||
      !capability || capability.toolServerId !== ZAI_VISION_MCP_SERVER_ID ||
      capability.toolName !== ZAI_VISION_MCP_TOOL_NAME ||
      capability.toolCapabilityDigest !== tuple.catalogCapabilityDigest) {
    throw new Error("zai_vision_carrier_unverified");
  }
}

function extensionForMime(mimeType: string): ".png" | ".jpeg" | ".webp" {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpeg";
  if (mimeType === "image/webp") return ".webp";
  throw new Error("image_derivative_mime_unsupported");
}

function safeMcpText(value: unknown, tempRoot: string, tempPath: string): string {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  if (record.isError === true) throw new Error("zai_vision_mcp_failed");
  const content = Array.isArray(record.content) ? record.content : [];
  const text = content
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object" && !Array.isArray(item)),
    )
    .map((item) => typeof item.text === "string" ? item.text : "")
    .filter(Boolean)
    .join("\n")
    .trim();
  if (text) return scrubTempPaths(text, tempRoot, tempPath).slice(0, MAX_RESULT_CHARS);
  const structured = record.structuredContent;
  if (structured !== undefined) {
    try {
      return scrubTempPaths(JSON.stringify(structured), tempRoot, tempPath)
        .slice(0, MAX_RESULT_CHARS);
    } catch { /* fall through */ }
  }
  return "(Z.AI Vision returned no textual analysis.)";
}

function scrubTempPaths(value: string, tempRoot: string, tempPath: string): string {
  return value
    .split(tempPath).join("[redacted-image-source]")
    .split(tempRoot).join("[redacted-image-directory]");
}
