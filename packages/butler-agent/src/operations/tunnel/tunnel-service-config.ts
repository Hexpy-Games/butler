import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  tunnelProxyConfigFromEnv,
  type TunnelProxyConfig,
} from "./tunnel-http-proxy-config.ts";

export const TUNNEL_PROXY_SERVICE_ID = "tunnel-proxy" as const;
export const TUNNEL_PROXY_CONFIG_SCHEMA = "butler.tunnel-proxy-config.v1" as const;

export interface TunnelProxyServiceConfig {
  schema: typeof TUNNEL_PROXY_CONFIG_SCHEMA;
  enabled: true;
  listen_host: string;
  listen_port: number;
  upstream: string;
  username?: string;
  password?: string;
  session_secret?: string;
  login_token?: string;
  upstream_bearer_token?: string;
  max_html_bytes?: number;
  max_buffered_bytes?: number;
}

export function tunnelProxyServiceConfigPath(butlerData: string): string {
  return join(butlerData, "state", "tunnel-proxy", "config.json");
}

export function readTunnelProxyServiceConfig(
  butlerData: string,
): TunnelProxyServiceConfig | null {
  const path = tunnelProxyServiceConfigPath(butlerData);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  return normalizeTunnelProxyServiceConfig(parsed);
}

export function writeTunnelProxyServiceConfigFromEnv(input: {
  butlerData: string;
  env?: Record<string, string | undefined>;
}): TunnelProxyServiceConfig {
  const source = tunnelProxyConfigFromEnv(input.env ?? process.env);
  const config = serviceConfigFromProxyConfig(source);
  const path = tunnelProxyServiceConfigPath(input.butlerData);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
  return config;
}

export function removeTunnelProxyServiceConfig(butlerData: string): void {
  rmSync(tunnelProxyServiceConfigPath(butlerData), { force: true });
}

export function tunnelProxyEnvironmentFromServiceConfig(
  config: TunnelProxyServiceConfig,
): Record<string, string> {
  return {
    BUTLER_TUNNEL_PROXY_ENABLED: "1",
    BUTLER_TUNNEL_PROXY_HOST: config.listen_host,
    BUTLER_TUNNEL_PROXY_PORT: String(config.listen_port),
    BUTLER_TUNNEL_PROXY_UPSTREAM: config.upstream,
    ...(config.username ? { BUTLER_TUNNEL_PROXY_USERNAME: config.username } : {}),
    ...(config.password ? { BUTLER_TUNNEL_PROXY_PASSWORD: config.password } : {}),
    ...(config.session_secret
      ? { BUTLER_TUNNEL_PROXY_SESSION_SECRET: config.session_secret }
      : {}),
    ...(config.login_token
      ? { BUTLER_TUNNEL_PROXY_LOGIN_TOKEN: config.login_token }
      : {}),
    ...(config.upstream_bearer_token
      ? { BUTLER_TUNNEL_PROXY_UPSTREAM_BEARER_TOKEN: config.upstream_bearer_token }
      : {}),
    ...(config.max_html_bytes
      ? { BUTLER_TUNNEL_PROXY_MAX_HTML_BYTES: String(config.max_html_bytes) }
      : {}),
    ...(config.max_buffered_bytes
      ? { BUTLER_TUNNEL_PROXY_MAX_BUFFERED_BYTES: String(config.max_buffered_bytes) }
      : {}),
  };
}

function serviceConfigFromProxyConfig(
  config: TunnelProxyConfig,
): TunnelProxyServiceConfig {
  const auth = config.auth ?? {};
  return normalizeTunnelProxyServiceConfig({
    schema: TUNNEL_PROXY_CONFIG_SCHEMA,
    enabled: true,
    listen_host: config.listenHost,
    listen_port: config.listenPort,
    upstream: config.upstream.toString(),
    ...(auth.basicUsername ? { username: auth.basicUsername } : {}),
    ...(auth.basicPassword ? { password: auth.basicPassword } : {}),
    ...(auth.sessionSecret ? { session_secret: auth.sessionSecret } : {}),
    ...(auth.loginToken ? { login_token: auth.loginToken } : {}),
    ...(auth.upstreamBearerToken
      ? { upstream_bearer_token: auth.upstreamBearerToken }
      : {}),
    ...(config.maxHtmlBytes
      ? { max_html_bytes: config.maxHtmlBytes }
      : {}),
    ...(config.maxBufferedBytes
      ? { max_buffered_bytes: config.maxBufferedBytes }
      : {}),
  });
}

function normalizeTunnelProxyServiceConfig(value: unknown): TunnelProxyServiceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid Butler tunnel proxy config");
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== TUNNEL_PROXY_CONFIG_SCHEMA || record.enabled !== true) {
    throw new Error("invalid Butler tunnel proxy config schema");
  }
  const listenHost = nonEmptyString(record.listen_host);
  const upstream = nonEmptyString(record.upstream);
  const listenPort = boundedInteger(record.listen_port, 1, 65_535);
  if (!listenHost || !upstream || listenPort === null) {
    throw new Error("invalid Butler tunnel proxy endpoint config");
  }
  const parsedUpstream = new URL(upstream);
  if (!/^https?:$/u.test(parsedUpstream.protocol) || parsedUpstream.username ||
    parsedUpstream.password) {
    throw new Error("invalid Butler tunnel proxy upstream URL");
  }
  const username = optionalString(record.username);
  const password = optionalString(record.password);
  const sessionSecret = optionalString(record.session_secret);
  const loginToken = optionalString(record.login_token);
  const upstreamBearerToken = optionalString(record.upstream_bearer_token);
  const maxHtmlBytes = boundedInteger(record.max_html_bytes, 1, 16 * 1024 * 1024);
  const maxBufferedBytes = boundedInteger(
    record.max_buffered_bytes,
    1,
    4 * 1024 * 1024,
  );
  if ((username === undefined) !== (password === undefined)) {
    throw new Error("Butler tunnel proxy Basic auth requires username and password");
  }
  return {
    schema: TUNNEL_PROXY_CONFIG_SCHEMA,
    enabled: true,
    listen_host: listenHost,
    listen_port: listenPort,
    upstream: parsedUpstream.toString(),
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(sessionSecret ? { session_secret: sessionSecret } : {}),
    ...(loginToken ? { login_token: loginToken } : {}),
    ...(upstreamBearerToken
      ? { upstream_bearer_token: upstreamBearerToken }
      : {}),
    ...(maxHtmlBytes !== null ? { max_html_bytes: maxHtmlBytes } : {}),
    ...(maxBufferedBytes !== null
      ? { max_buffered_bytes: maxBufferedBytes }
      : {}),
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalString(value: unknown): string | undefined {
  const normalized = nonEmptyString(value);
  return normalized ?? undefined;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  const candidate = Number(value);
  return Number.isInteger(candidate) && candidate >= minimum && candidate <= maximum
    ? candidate
    : null;
}
