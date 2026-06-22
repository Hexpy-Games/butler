import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  resolveSecretValue,
  type McpKeyValueSecret,
  type McpServerConfig,
} from "./registry.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PAGES = 8;

export async function withMcpClient<T>(
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

export async function listAllMcpPages<T>(
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

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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

function resolveKeyValueSecrets(values: McpKeyValueSecret[]): Record<string, string> {
  return Object.fromEntries(
    values
      .map((item) => [item.key, resolveSecretValue(item)] as const)
      .filter(([, value]) => value.length > 0),
  );
}

export async function withTimeout<T>(
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
