import {
  createTunnelProxyServer,
  type TunnelProxyServer,
} from "./tunnel-http-proxy-relay.ts";
import {
  tunnelProxyConfigFromEnv,
} from "./tunnel-http-proxy-config.ts";

export {
  DEFAULT_BOOTSTRAP_PATH,
  DEFAULT_BOOTSTRAP_SCRIPT,
  DEFAULT_MAX_BUFFERED_BYTES,
  DEFAULT_MAX_HTML_BYTES,
  HOP_BY_HOP_HEADERS,
  forwardedTunnelRequestHeaders,
  forwardedTunnelResponseHeaders,
  isTunnelRequestAuthorized,
  normalizeTunnelProxyConfig,
  rejectTunnelUnauthorized,
  rewriteTunnelHtml,
  setTunnelSessionCookie,
  tunnelProxyConfigFromEnv,
} from "./tunnel-http-proxy-config.ts";
export type {
  NormalizedTunnelProxyConfig,
  TunnelProxyAuthConfig,
  TunnelProxyConfig,
} from "./tunnel-http-proxy-config.ts";
export { createTunnelProxyServer } from "./tunnel-http-proxy-relay.ts";
export type { TunnelProxyServer } from "./tunnel-http-proxy-relay.ts";

/** Start the repository-owned operational tunnel from injected environment. */
export async function startTunnelProxyFromEnv(
  env: Record<string, string | undefined> = process.env,
): Promise<TunnelProxyServer> {
  return createTunnelProxyServer(tunnelProxyConfigFromEnv(env));
}
