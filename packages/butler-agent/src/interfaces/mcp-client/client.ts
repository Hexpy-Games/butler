import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  getMcpServer,
  readMcpRegistry,
  resolveSecretValue,
  type McpKeyValueSecret,
  type McpServerConfig,
} from "./registry.ts";

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

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PAGES = 8;

export async function listMcpServerCapabilities(input: {
  butlerData: string;
  includeDisabled?: boolean;
  timeoutMs?: number;
}): Promise<McpCapabilitiesView> {
  const registry = readMcpRegistry(input.butlerData);
  const servers = input.includeDisabled
    ? registry.servers
    : registry.servers.filter((server) => server.enabled);
  const views: McpCapabilityServerView[] = [];
  for (const server of servers) {
    views.push(await probeMcpServerConfig(server, {
      timeoutMs: input.timeoutMs,
      skipDisabled: !input.includeDisabled,
    }));
  }
  return { servers: views };
}

export async function probeMcpServer(input: {
  butlerData: string;
  serverId: string;
  timeoutMs?: number;
}): Promise<McpCapabilityServerView> {
  const server = requireMcpServer(input.butlerData, input.serverId);
  return await probeMcpServerConfig(server, { timeoutMs: input.timeoutMs });
}

export async function callMcpTool(input: {
  butlerData: string;
  serverId: string;
  toolName: string;
  args?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<McpCallToolResultView> {
  const server = requireEnabledMcpServer(input.butlerData, input.serverId);
  const toolName = input.toolName.trim();
  if (!toolName) throw new Error("MCP tool name is required.");
  const result = await withMcpClient(server, input.timeoutMs, async (client) =>
    await withTimeout(
      client.callTool({
        name: toolName,
        arguments: input.args ?? {},
      }),
      input.timeoutMs,
      `MCP tool timed out: ${server.id}/${toolName}`,
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
}): Promise<McpReadResourceResultView> {
  const server = requireEnabledMcpServer(input.butlerData, input.serverId);
  const uri = input.uri.trim();
  if (!uri) throw new Error("MCP resource uri is required.");
  const result = await withMcpClient(server, input.timeoutMs, async (client) =>
    await withTimeout(
      client.readResource({ uri }),
      input.timeoutMs,
      `MCP resource read timed out: ${server.id}/${uri}`,
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
  options: { timeoutMs?: number; skipDisabled?: boolean } = {},
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
    const capabilities = await withMcpClient(server, options.timeoutMs, async (client) => {
      const [tools, resources, templates] = await Promise.all([
        listAllMcpPages((cursor) => client.listTools(cursor ? { cursor } : undefined), "tools"),
        listAllMcpPages((cursor) => client.listResources(cursor ? { cursor } : undefined), "resources"),
        listAllMcpPages(
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
    });
    return { ...base, ...capabilities, ok: true, error: null };
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function withMcpClient<T>(
  server: McpServerConfig,
  timeoutMs: number | undefined,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    name: "butler-mcp-client",
    version: "1.0.0",
  });
  const transport = createTransport(server);
  try {
    await withTimeout(
      client.connect(transport),
      timeoutMs,
      `MCP connection timed out: ${server.id}`,
    );
    return await fn(client);
  } finally {
    await client.close().catch(() => transport.close?.());
  }
}

function createTransport(server: McpServerConfig): Transport {
  if (server.transport === "stdio") {
    return new StdioClientTransport({
      command: server.command ?? "",
      args: server.args ?? [],
      cwd: server.cwd,
      env: {
        ...getDefaultEnvironment(),
        ...resolveKeyValueSecrets(server.env ?? []),
      },
      stderr: "pipe",
    });
  }
  const headers = resolveKeyValueSecrets(server.headers ?? []);
  if (server.transport === "sse") {
    return new SSEClientTransport(new URL(server.url ?? ""), {
      requestInit: { headers },
      eventSourceInit: {
        fetch: (url: RequestInfo | URL, init?: RequestInit) =>
          fetch(url, {
            ...init,
            headers: {
              ...(init?.headers ?? {}),
              ...headers,
            },
          }),
      } as any,
    });
  }
  return new StreamableHTTPClientTransport(new URL(server.url ?? ""), {
    requestInit: { headers },
  });
}

async function listAllMcpPages<T>(
  load: (cursor?: string) => Promise<Record<string, unknown>>,
  key: string,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await load(cursor);
    const values = result[key];
    if (Array.isArray(values)) items.push(...values as T[]);
    cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    if (!cursor) break;
  }
  return items;
}

function resolveKeyValueSecrets(values: McpKeyValueSecret[]): Record<string, string> {
  return Object.fromEntries(
    values
      .map((item) => [item.key, resolveSecretValue(item)] as const)
      .filter(([, value]) => value.length > 0),
  );
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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  message: string,
): Promise<T> {
  const ms = Math.max(1000, timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
