import { createHash } from "node:crypto";
import {
  getMcpServer,
  type McpServerConfig,
} from "../../interfaces/mcp-client/registry.ts";
import { probeMcpServer } from "../../interfaces/mcp-client/client.ts";
import type { ImageCapabilityCatalogEntry } from "./contracts.ts";

export const ZAI_VISION_MCP_SERVER_ID = "zai-vision" as const;
export const ZAI_VISION_MCP_TOOL_NAME = "analyze_image" as const;

/**
 * Resolve the tool-assisted carrier only for the exact Coding Plan model and
 * the enabled, schema-proven `zai-vision/analyze_image` server.  Discovery
 * failures return a fresh unverified entry; a prior dynamic digest is never
 * allowed to survive a failed revalidation.
 */
export async function resolveZaiMcpVisionCatalogEntry(input: {
  entry: ImageCapabilityCatalogEntry | undefined;
  modelRef: string;
  butlerData: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ImageCapabilityCatalogEntry | undefined> {
  const entry = input.entry;
  if (!entry || entry.provider_id !== "zai" ||
      entry.model_ref !== input.modelRef || entry.model_id !== "glm-5.2" ||
      entry.image_carrier_protocol !== "zai_mcp_vision") {
    return entry;
  }
  const server = getMcpServer(input.butlerData, ZAI_VISION_MCP_SERVER_ID);
  if (!server?.enabled) return unverifiedEntry(entry);
  let toolDigest: string | undefined;
  try {
    const capabilities = await probeMcpServer({
      butlerData: input.butlerData,
      serverId: ZAI_VISION_MCP_SERVER_ID,
      timeoutMs: input.timeoutMs ?? 10_000,
      signal: input.signal,
    });
    if (!capabilities.ok) return unverifiedEntry(entry);
    const tool = capabilities.tools.find((candidate) =>
      candidate.name === ZAI_VISION_MCP_TOOL_NAME,
    );
    if (!tool || !schemaAcceptsImageSourceAndPrompt(tool.input_schema)) {
      return unverifiedEntry(entry);
    }
    toolDigest = sha256Canonical({
      route: {
        provider_id: entry.provider_id,
        model_id: entry.model_id,
        credential_id: typeof (entry as { credential_id?: unknown }).credential_id === "string"
          ? (entry as { credential_id: string }).credential_id
          : null,
      },
      server: {
        id: server.id,
        transport: server.transport,
        command: server.command ?? null,
        args: server.args ?? [],
        cwd: server.cwd ?? null,
        url: server.url ?? null,
        env: (server.env ?? []).map((item) => ({ key: item.key, source: item.source })),
        headers: (server.headers ?? []).map((item) => ({ key: item.key, source: item.source })),
        updated_at: server.updated_at,
      },
      tool: { name: ZAI_VISION_MCP_TOOL_NAME, input_schema: tool.input_schema },
    });
  } catch {
    return unverifiedEntry(entry);
  }
  return {
    ...entry,
    image_input_verified: true,
    image_capability_digest: toolDigest,
    image_tool_capability_digest: toolDigest,
    image_tool_server_id: ZAI_VISION_MCP_SERVER_ID,
    image_tool_name: ZAI_VISION_MCP_TOOL_NAME,
  };
}

function unverifiedEntry(entry: ImageCapabilityCatalogEntry): ImageCapabilityCatalogEntry {
  return {
    ...entry,
    image_input_verified: false,
    image_capability_digest: undefined,
    image_tool_capability_digest: undefined,
    image_tool_server_id: undefined,
    image_tool_name: undefined,
  };
}

function schemaAcceptsImageSourceAndPrompt(
  schema: Record<string, unknown> | undefined,
): boolean {
  if (!schema) return false;
  const properties = schema.properties;
  const required = schema.required;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return false;
  if (!Array.isArray(required)) return false;
  return required.includes("image_source") && required.includes("prompt") &&
    Object.prototype.hasOwnProperty.call(properties, "image_source") &&
    Object.prototype.hasOwnProperty.call(properties, "prompt");
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function isEnabledZaiVisionMcpServer(
  server: McpServerConfig | null,
): boolean {
  return Boolean(server?.id === ZAI_VISION_MCP_SERVER_ID && server.enabled);
}
