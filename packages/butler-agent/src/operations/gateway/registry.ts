import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";

export type GatewayId = "app" | "telegram";
export type GatewayLifecycle = "process" | "embedded";

export interface GatewayDefinition {
  id: GatewayId;
  title: string;
  lifecycle: GatewayLifecycle;
  transport: string;
  summary: string;
}

export interface GatewaySettings {
  id: GatewayId;
  enabled?: boolean;
  config?: Record<string, unknown>;
  updatedAt?: string;
}

export interface AppGatewayRuntimeConfig {
  host: string;
  port: number;
  dbPath: string | null;
  serverUrl: string;
  dbConfigured: boolean;
}

export interface TelegramGatewayRuntimeConfig {
  enabled: boolean;
  chatId: string | null;
  defaultFormat: "markdownv2" | "plain";
  tokenConfigured: boolean;
  chatPaired: boolean;
}

export interface GatewayStatusView {
  id: GatewayId;
  title: string;
  lifecycle: GatewayLifecycle;
  transport: string;
  enabled: boolean;
  configured: boolean;
  running: boolean;
  status: "online" | "offline" | "disabled" | "embedded" | "unconfigured";
  restartRequired: boolean;
  credentials: Record<string, boolean>;
  config: Record<string, unknown>;
  nextActions: string[];
}

export const GATEWAY_DEFINITIONS: GatewayDefinition[] = [
  {
    id: "app",
    title: "Butler App Gateway",
    lifecycle: "process",
    transport: "app",
    summary: "Local HTTP gateway for the Butler App client.",
  },
  {
    id: "telegram",
    title: "Telegram Gateway",
    lifecycle: "embedded",
    transport: "telegram",
    summary: "Telegram DM/group gateway hosted by butler-main.",
  },
];

const gatewayIds = new Set<GatewayId>(GATEWAY_DEFINITIONS.map((gateway) => gateway.id));

function readJson(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  } catch {
    return {};
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function readEnvValue(path: string, key: string): string {
  if (!existsSync(path)) return "";
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`).exec(line);
    if (!match) continue;
    return match[1]!.trim().replace(/^['"]|['"]$/g, "");
  }
  return "";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizePort(value: unknown, fallback: number): number {
  const parsed = numberValue(value);
  if (parsed === null || parsed < 1 || parsed > 65_535) return fallback;
  return Math.trunc(parsed);
}

export function gatewaySettingsPath(butlerData: string, id: GatewayId): string {
  return join(butlerData, "gateways", `${id}.json`);
}

export function appGatewayPidPath(butlerData: string): string {
  return join(butlerData, "state", "gateways", "app.pid");
}

export function appGatewayLogPaths(butlerData: string): { stdout: string; stderr: string } {
  return {
    stdout: join(butlerData, "logs", "app-gateway-out.log"),
    stderr: join(butlerData, "logs", "app-gateway-err.log"),
  };
}

export function assertGatewayId(value: string | undefined): GatewayId {
  if (value === "app" || value === "telegram") return value;
  throw new Error(`unsupported gateway: ${value ?? ""}`);
}

export function findGatewayDefinition(id: GatewayId): GatewayDefinition {
  return GATEWAY_DEFINITIONS.find((gateway) => gateway.id === id)!;
}

export function readGatewaySettings(butlerData: string, id: GatewayId): GatewaySettings {
  const stored = readJson(gatewaySettingsPath(butlerData, id));
  return {
    id,
    enabled: typeof stored.enabled === "boolean" ? stored.enabled : undefined,
    config: stored.config && typeof stored.config === "object" && !Array.isArray(stored.config)
      ? stored.config
      : {},
    updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : undefined,
  };
}

export function writeGatewaySettings(
  butlerData: string,
  id: GatewayId,
  next: Omit<GatewaySettings, "id">,
): GatewaySettings {
  const settings: GatewaySettings = {
    id,
    enabled: next.enabled,
    config: next.config ?? {},
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(gatewaySettingsPath(butlerData, id), settings);
  return settings;
}

export function patchGatewaySettings(
  butlerData: string,
  id: GatewayId,
  patch: Partial<Omit<GatewaySettings, "id">>,
): GatewaySettings {
  const current = readGatewaySettings(butlerData, id);
  return writeGatewaySettings(butlerData, id, {
    enabled: patch.enabled ?? current.enabled,
    config: {
      ...(current.config ?? {}),
      ...(patch.config ?? {}),
    },
  });
}

export function removeGatewayConfigKeys(
  butlerData: string,
  id: GatewayId,
  keys: string[],
): GatewaySettings {
  const current = readGatewaySettings(butlerData, id);
  const config = { ...(current.config ?? {}) };
  for (const key of keys) delete config[key];
  return writeGatewaySettings(butlerData, id, {
    enabled: current.enabled,
    config,
  });
}

export function isGatewayEnabled(butlerData: string, id: GatewayId): boolean {
  const settings = readGatewaySettings(butlerData, id);
  return settings.enabled !== false;
}

export function gatewayCompatibilityConfigPath(butlerData: string): string {
  return join(butlerData, "butler.config.json");
}

export function readCompatibilityConfig(butlerData: string): Record<string, any> {
  return readJson(gatewayCompatibilityConfigPath(butlerData));
}

export function writeCompatibilityConfig(butlerData: string, config: Record<string, any>): void {
  atomicWriteJson(gatewayCompatibilityConfigPath(butlerData), config);
}

export function updateTelegramCompatibilityConfig(
  butlerData: string,
  input: { chatId?: string; defaultFormat?: "markdownv2" | "plain" },
): void {
  const config = readCompatibilityConfig(butlerData);
  config.telegram = config.telegram && typeof config.telegram === "object"
    ? config.telegram
    : {};
  if (input.chatId !== undefined) config.telegram.groupId = input.chatId;
  if (input.defaultFormat !== undefined) config.telegram.defaultFormat = input.defaultFormat;
  writeCompatibilityConfig(butlerData, config);
}

export function resolveAppGatewayRuntimeConfig(input: {
  butlerData: string;
  env?: Record<string, string | undefined>;
  argvPort?: number | null;
}): AppGatewayRuntimeConfig {
  const env = input.env ?? process.env;
  const settings = readGatewaySettings(input.butlerData, "app");
  const config = settings.config ?? {};
  const host = env.BUTLER_APP_SERVER_HOST?.trim() ||
    stringValue(config.host) ||
    "127.0.0.1";
  const port = normalizePort(
    env.BUTLER_APP_SERVER_PORT ?? input.argvPort ?? config.port,
    18_765,
  );
  const dbPath = env.BUTLER_APP_SERVER_DB?.trim() ||
    stringValue(config.dbPath) ||
    null;
  return {
    host,
    port,
    dbPath,
    serverUrl: `http://${host}:${port}`,
    dbConfigured: Boolean(dbPath),
  };
}

export function resolveTelegramGatewayRuntimeConfig(input: {
  butlerData: string;
  env?: Record<string, string | undefined>;
  compatibilityConfig?: Record<string, any>;
}): TelegramGatewayRuntimeConfig {
  const env = input.env ?? process.env;
  const settings = readGatewaySettings(input.butlerData, "telegram");
  const config = settings.config ?? {};
  const compatibility = input.compatibilityConfig ?? readCompatibilityConfig(input.butlerData);
  const envPath = join(input.butlerData, ".env");
  const token = env.TELEGRAM_BOT_TOKEN?.trim() ||
    readEnvValue(envPath, "TELEGRAM_BOT_TOKEN");
  const chatId = stringValue(config.chatId) ||
    env.TELEGRAM_CHAT_ID?.trim() ||
    readEnvValue(envPath, "TELEGRAM_CHAT_ID") ||
    stringValue(compatibility.telegram?.groupId);
  const configuredFormat = stringValue(config.defaultFormat) ||
    stringValue(compatibility.telegram?.defaultFormat) ||
    "markdownv2";
  const defaultFormat = configuredFormat === "plain" ? "plain" : "markdownv2";
  return {
    enabled: settings.enabled !== false,
    chatId: chatId || null,
    defaultFormat,
    tokenConfigured: Boolean(token),
    chatPaired: Boolean(chatId),
  };
}

export function readAppGatewayPid(butlerData: string): number | null {
  try {
    const value = Number.parseInt(readFileSync(appGatewayPidPath(butlerData), "utf8").trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeAppGatewayPid(butlerData: string, pid: number): void {
  const path = appGatewayPidPath(butlerData);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${pid}\n`, { mode: 0o600 });
}

export function clearAppGatewayPid(butlerData: string): void {
  rmSync(appGatewayPidPath(butlerData), { force: true });
}

export function isProcessAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function healthOk(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300);
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/health`, {
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null) as {
      protocol_version?: string;
      data?: { ok?: boolean };
    } | null;
    return response.ok &&
      body?.protocol_version === "butler.app.v1" &&
      body?.data?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function buildGatewayStatusView(
  butlerData: string,
  id: GatewayId,
): Promise<GatewayStatusView> {
  const definition = findGatewayDefinition(id);
  const enabled = isGatewayEnabled(butlerData, id);
  if (id === "app") {
    const app = resolveAppGatewayRuntimeConfig({ butlerData });
    const pid = readAppGatewayPid(butlerData);
    const pidRunning = isProcessAlive(pid);
    const healthy = enabled ? await healthOk(app.serverUrl) : false;
    const running = pidRunning || healthy;
    const configured = Boolean(app.host && app.port);
    return {
      id,
      title: definition.title,
      lifecycle: definition.lifecycle,
      transport: definition.transport,
      enabled,
      configured,
      running,
      status: !enabled ? "disabled" : running ? "online" : "offline",
      restartRequired: false,
      credentials: {},
      config: {
        host: app.host,
        port: app.port,
        serverUrl: app.serverUrl,
        dbConfigured: app.dbConfigured,
      },
      nextActions: !enabled
        ? ["butler gateway enable app"]
        : running
          ? ["butler gateway status app"]
          : ["butler gateway start app"],
    };
  }

  const telegram = resolveTelegramGatewayRuntimeConfig({ butlerData });
  return {
    id,
    title: definition.title,
    lifecycle: definition.lifecycle,
    transport: definition.transport,
    enabled,
    configured: telegram.tokenConfigured && telegram.chatPaired,
    running: enabled,
    status: !enabled
      ? "disabled"
      : telegram.tokenConfigured && telegram.chatPaired
        ? "embedded"
        : "unconfigured",
    restartRequired: false,
    credentials: {
      botToken: telegram.tokenConfigured,
    },
    config: {
      chatPaired: telegram.chatPaired,
      defaultFormat: telegram.defaultFormat,
    },
    nextActions: !enabled
      ? ["butler gateway enable telegram"]
      : telegram.tokenConfigured && telegram.chatPaired
        ? ["butler gateway test telegram"]
        : ["butler gateway credential set telegram --token-stdin", "butler gateway pair telegram"],
  };
}

export function supportedGatewayIds(): GatewayId[] {
  return [...gatewayIds];
}

