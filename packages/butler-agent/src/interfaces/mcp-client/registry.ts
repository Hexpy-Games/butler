import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";

export type McpTransportKind = "stdio" | "http" | "sse";
export type McpSecretSource = "literal" | "env" | "file";

export interface McpSecretValue {
  source: McpSecretSource;
  value: string;
}

export interface McpKeyValueSecret extends McpSecretValue {
  key: string;
}

export interface McpServerConfig {
  id: string;
  display_name: string;
  enabled: boolean;
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: McpKeyValueSecret[];
  headers?: McpKeyValueSecret[];
  created_at: string;
  updated_at: string;
}

export interface McpServerRegistry {
  version: 1;
  servers: McpServerConfig[];
}

export interface McpSecretValueView {
  key: string;
  source: McpSecretSource;
  value?: string;
  redacted: boolean;
  has_value: boolean;
}

export interface McpServerView {
  id: string;
  display_name: string;
  enabled: boolean;
  transport: McpTransportKind;
  command?: string;
  args: string[];
  cwd?: string;
  url?: string;
  env: McpSecretValueView[];
  headers: McpSecretValueView[];
  created_at: string;
  updated_at: string;
}

export interface McpServerUpsertInput {
  id?: string;
  display_name?: string;
  enabled?: boolean;
  transport?: McpTransportKind;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: McpKeyValueSecret[];
  headers?: McpKeyValueSecret[];
}

export interface McpServerListView {
  storage_path: string;
  servers: McpServerView[];
}

export function mcpRegistryPath(butlerData: string): string {
  return join(butlerData, "config", "mcp-servers.json");
}

export function readMcpRegistry(butlerData: string): McpServerRegistry {
  const path = mcpRegistryPath(butlerData);
  if (!existsSync(path)) return { version: 1, servers: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<McpServerRegistry>;
  return normalizeRegistry(parsed);
}

export function writeMcpRegistry(
  butlerData: string,
  registry: McpServerRegistry,
): void {
  const path = mcpRegistryPath(butlerData);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(normalizeRegistry(registry), null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tmp, path);
}

export function listMcpServers(butlerData: string): McpServerListView {
  return {
    storage_path: mcpRegistryPath(butlerData),
    servers: readMcpRegistry(butlerData).servers.map(redactMcpServer),
  };
}

export function getMcpServer(
  butlerData: string,
  serverId: string,
): McpServerConfig | null {
  const id = normalizeServerId(serverId);
  return readMcpRegistry(butlerData).servers.find((server) => server.id === id) ?? null;
}

export function upsertMcpServer(
  butlerData: string,
  input: McpServerUpsertInput,
): McpServerView {
  const id = normalizeServerId(input.id ?? input.display_name ?? "");
  if (!id) throw new Error("MCP server id is required.");
  const now = new Date().toISOString();
  const registry = readMcpRegistry(butlerData);
  const existing = registry.servers.find((server) => server.id === id);
  const next = normalizeServer({
    ...(existing ?? {
      id,
      display_name: input.display_name?.trim() || id,
      enabled: true,
      transport: input.transport ?? "stdio",
      created_at: now,
      updated_at: now,
    }),
    ...withoutUndefined(input),
    id,
    display_name: input.display_name?.trim() || existing?.display_name || id,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  });
  const index = registry.servers.findIndex((server) => server.id === id);
  if (index === -1) registry.servers.push(next);
  else registry.servers[index] = next;
  registry.servers.sort((a, b) => a.display_name.localeCompare(b.display_name));
  writeMcpRegistry(butlerData, registry);
  return redactMcpServer(next);
}

export function updateMcpServer(
  butlerData: string,
  serverId: string,
  input: McpServerUpsertInput,
): McpServerView {
  const id = normalizeServerId(serverId);
  const registry = readMcpRegistry(butlerData);
  const existing = registry.servers.find((server) => server.id === id);
  if (!existing) throw new Error(`MCP server not found: ${serverId}`);
  const mergedInput = {
    ...input,
    ...("env" in input
      ? { env: mergeSecretUpdates(existing.env ?? [], input.env) }
      : {}),
    ...("headers" in input
      ? { headers: mergeSecretUpdates(existing.headers ?? [], input.headers) }
      : {}),
  };
  const next = normalizeServer({
    ...existing,
    ...withoutUndefined(mergedInput),
    id,
    display_name: input.display_name?.trim() || existing.display_name,
    created_at: existing.created_at,
    updated_at: new Date().toISOString(),
  });
  registry.servers = registry.servers.map((server) => server.id === id ? next : server);
  writeMcpRegistry(butlerData, registry);
  return redactMcpServer(next);
}

export function deleteMcpServer(butlerData: string, serverId: string): {
  id: string;
  removed: boolean;
} {
  const id = normalizeServerId(serverId);
  const registry = readMcpRegistry(butlerData);
  const before = registry.servers.length;
  registry.servers = registry.servers.filter((server) => server.id !== id);
  const removed = registry.servers.length !== before;
  if (removed) writeMcpRegistry(butlerData, registry);
  return { id, removed };
}

export function redactMcpServer(server: McpServerConfig): McpServerView {
  return {
    id: server.id,
    display_name: server.display_name,
    enabled: server.enabled,
    transport: server.transport,
    command: server.command,
    args: server.args ?? [],
    cwd: server.cwd,
    url: server.url,
    env: (server.env ?? []).map(redactSecret),
    headers: (server.headers ?? []).map(redactSecret),
    created_at: server.created_at,
    updated_at: server.updated_at,
  };
}

export function normalizeServerId(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

export function resolveSecretValue(secret: McpSecretValue): string {
  if (secret.source === "literal") return secret.value;
  if (secret.source === "env") return process.env[secret.value] ?? "";
  if (secret.source === "file") return existsSync(secret.value)
    ? readFileSync(secret.value, "utf8").trimEnd()
    : "";
  return "";
}

function normalizeRegistry(input: Partial<McpServerRegistry>): McpServerRegistry {
  return {
    version: 1,
    servers: Array.isArray(input.servers)
      ? input.servers
        .filter((server): server is McpServerConfig => Boolean(server && typeof server === "object"))
        .map(normalizeServer)
        .filter((server) => server.id)
      : [],
  };
}

function normalizeServer(input: Partial<McpServerConfig>): McpServerConfig {
  const now = new Date().toISOString();
  const transport = normalizeTransport(input.transport);
  const id = normalizeServerId(input.id ?? input.display_name ?? "");
  const server: McpServerConfig = {
    id,
    display_name: input.display_name?.trim() || id,
    enabled: input.enabled !== false,
    transport,
    args: normalizeStringArray(input.args),
    env: normalizeSecrets(input.env),
    headers: normalizeSecrets(input.headers),
    created_at: input.created_at || now,
    updated_at: input.updated_at || now,
  };
  const command = cleanString(input.command);
  const cwd = cleanString(input.cwd);
  const url = cleanString(input.url);
  if (command) server.command = command;
  if (cwd) server.cwd = cwd;
  if (url) server.url = url;
  validateServer(server);
  return server;
}

function normalizeTransport(value: unknown): McpTransportKind {
  if (value === "http" || value === "sse" || value === "stdio") return value;
  return "stdio";
}

function validateServer(server: McpServerConfig): void {
  if (!server.id) throw new Error("MCP server id is required.");
  if (server.transport === "stdio" && !server.command) {
    throw new Error("stdio MCP servers require command.");
  }
  if ((server.transport === "http" || server.transport === "sse") && !server.url) {
    throw new Error(`${server.transport} MCP servers require url.`);
  }
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeSecrets(value: unknown): McpKeyValueSecret[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Partial<McpKeyValueSecret> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      key: cleanSecretKey(item.key),
      source: normalizeSecretSource(item.source),
      value: typeof item.value === "string" ? item.value : "",
    }))
    .filter((item) => item.key && item.value);
}

function mergeSecretUpdates(
  existing: McpKeyValueSecret[],
  updates: McpKeyValueSecret[] | undefined,
): McpKeyValueSecret[] {
  if (!Array.isArray(updates)) return existing;
  const existingByKey = new Map(
    existing.map((secret) => [cleanSecretKey(secret.key), secret]),
  );
  return updates.flatMap((update) => {
    const key = cleanSecretKey(update.key);
    if (!key) return [];
    const source = normalizeSecretSource(update.source);
    if (update.value) return [{ key, source, value: update.value }];
    const existingSecret = existingByKey.get(key);
    return existingSecret ? [existingSecret] : [];
  });
}

function cleanSecretKey(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/[^\w.-]/gu, "_") : "";
}

function normalizeSecretSource(value: unknown): McpSecretSource {
  return value === "env" || value === "file" || value === "literal"
    ? value
    : "literal";
}

function redactSecret(secret: McpKeyValueSecret): McpSecretValueView {
  return {
    key: secret.key,
    source: secret.source,
    value: secret.source === "literal" ? undefined : secret.value,
    redacted: secret.source === "literal",
    has_value: Boolean(secret.value),
  };
}

function withoutUndefined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
