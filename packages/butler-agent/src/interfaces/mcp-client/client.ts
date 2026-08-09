import {
  getMcpServer,
  readMcpRegistry,
  type McpServerConfig,
} from "./registry.ts";
import { asRecord, listAllMcpPages, withMcpClient, withTimeout } from "./session.ts";

export interface McpCapabilityServerView {
  id: string;
  display_name: string;
  enabled: boolean;
  transport: McpServerConfig["transport"];
  tools: Array<{
    name: string;
    qualified_name: string;
    description?: string;
    input_schema?: Record<string, unknown>;
  }>;
  resources: Array<{
    uri: string;
    name: string;
    description?: string;
    mime_type?: string;
  }>;
  resource_templates: Array<{
    uri_template: string;
    name: string;
    description?: string;
    mime_type?: string;
  }>;
  ok: boolean;
  error: string | null;
}

export interface McpCapabilitiesView {
  servers: McpCapabilityServerView[];
}

export interface McpCallToolResultView {
  server_id: string;
  tool_name: string;
  result: unknown;
}

export interface McpReadResourceResultView {
  server_id: string;
  uri: string;
  result: unknown;
}

export async function listMcpServerCapabilities(input: {
  butlerData: string;
  includeDisabled?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<McpCapabilitiesView> {
  const registry = readMcpRegistry(input.butlerData);
  const servers = input.includeDisabled
    ? registry.servers
    : registry.servers.filter((server) => server.enabled);
  const views: McpCapabilityServerView[] = [];
  for (const server of servers) {
    views.push(await probeMcpServerConfig(server, {
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      skipDisabled: !input.includeDisabled,
    }));
  }
  return { servers: views };
}

export async function probeMcpServer(input: {
  butlerData: string;
  serverId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<McpCapabilityServerView> {
  const server = requireMcpServer(input.butlerData, input.serverId);
  return await probeMcpServerConfig(server, {
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
}

export async function callMcpTool(input: {
  butlerData: string;
  serverId: string;
  toolName: string;
  args?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<McpCallToolResultView> {
  const server = requireEnabledMcpServer(input.butlerData, input.serverId);
  const toolName = input.toolName.trim();
  if (!toolName) throw new Error("MCP tool name is required.");
  const result = await withMcpClient(server, input.timeoutMs, input.signal, async (client) =>
    await withTimeout(
      client.callTool({
        name: toolName,
        arguments: input.args ?? {},
      }),
      input.timeoutMs,
      `MCP tool timed out: ${server.id}/${toolName}`,
      input.signal,
    ),
  );
  return {
    server_id: server.id,
    tool_name: toolName,
    result,
  };
}

export async function readMcpResource(input: {
  butlerData: string;
  serverId: string;
  uri: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<McpReadResourceResultView> {
  const server = requireEnabledMcpServer(input.butlerData, input.serverId);
  const uri = input.uri.trim();
  if (!uri) throw new Error("MCP resource uri is required.");
  const result = await withMcpClient(server, input.timeoutMs, input.signal, async (client) =>
    await withTimeout(
      client.readResource({ uri }),
      input.timeoutMs,
      `MCP resource read timed out: ${server.id}/${uri}`,
      input.signal,
    ),
  );
  return {
    server_id: server.id,
    uri,
    result,
  };
}

async function probeMcpServerConfig(
  server: McpServerConfig,
  options: {
    timeoutMs?: number;
    skipDisabled?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<McpCapabilityServerView> {
  const base = {
    id: server.id,
    display_name: server.display_name,
    enabled: server.enabled,
    transport: server.transport,
    tools: [],
    resources: [],
    resource_templates: [],
  };
  if (!server.enabled && options.skipDisabled) {
    return { ...base, ok: false, error: "server disabled" };
  }
  try {
    const capabilities = await withMcpClient(
      server,
      options.timeoutMs,
      options.signal,
      async (client) => {
      const [tools, resources, templates] = await Promise.all([
        listAllMcpPages((cursor) => client.listTools(cursor ? { cursor } : undefined), "tools"),
        optionalMcpPage(
          (cursor) => client.listResources(cursor ? { cursor } : undefined),
          "resources",
        ),
        optionalMcpPage(
          (cursor) => client.listResourceTemplates(cursor ? { cursor } : undefined),
          "resourceTemplates",
        ),
      ]);
      return {
        tools: tools.map((tool: any) => {
          const name = String(tool.name ?? "");
          return {
            name,
            qualified_name: name ? `${server.id}/${name}` : "",
            description: typeof tool.description === "string" ? tool.description : undefined,
            input_schema: asRecord(tool.inputSchema),
          };
        }).filter((tool) => tool.name),
        resources: resources.map((resource: any) => ({
          uri: String(resource.uri ?? ""),
          name: String(resource.name ?? resource.uri ?? ""),
          description: typeof resource.description === "string" ? resource.description : undefined,
          mime_type: typeof resource.mimeType === "string" ? resource.mimeType : undefined,
        })).filter((resource) => resource.uri),
        resource_templates: templates.map((template: any) => ({
          uri_template: String(template.uriTemplate ?? ""),
          name: String(template.name ?? template.uriTemplate ?? ""),
          description: typeof template.description === "string" ? template.description : undefined,
          mime_type: typeof template.mimeType === "string" ? template.mimeType : undefined,
        })).filter((template) => template.uri_template),
      };
      },
    );
    return { ...base, ...capabilities, ok: true, error: null };
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * MCP tools-only servers are valid capability providers.  Some servers
 * advertise no resources or resource templates and answer those optional
 * methods with JSON-RPC -32601; discovery must preserve their tools instead
 * of turning the whole server probe into an error.
 */
async function optionalMcpPage<T>(
  load: (cursor?: string) => Promise<Record<string, unknown>>,
  key: string,
): Promise<T[]> {
  try {
    return await listAllMcpPages<T>(load, key);
  } catch (error) {
    if (isMcpMethodNotFound(error)) return [];
    throw error;
  }
}

function isMcpMethodNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === -32601 || code === "-32601") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:^|\D)-32601(?:\D|$)|method\s+not\s+found/iu.test(message);
}

function requireMcpServer(butlerData: string, serverId: string): McpServerConfig {
  const server = getMcpServer(butlerData, serverId);
  if (!server) throw new Error(`MCP server not found: ${serverId}`);
  return server;
}

function requireEnabledMcpServer(
  butlerData: string,
  serverId: string,
): McpServerConfig {
  const server = requireMcpServer(butlerData, serverId);
  if (!server.enabled) throw new Error(`MCP server is disabled: ${server.id}`);
  return server;
}
