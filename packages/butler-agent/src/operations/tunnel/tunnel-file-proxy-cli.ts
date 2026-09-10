import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createTunnelProxyServer } from "./tunnel-http-proxy.ts";

// File-backed operational entrypoint for installations with the original
// LaunchAgent. Authentication/relay policy remains repository-owned.
const data = process.env.BUTLER_DATA ?? join(homedir(), ".butler");
const authFile = process.env.BUTLER_TUNNEL_PROXY_AUTH_FILE ?? join(data, "tunnel", "butler-tunnel-auth.json");
const localAuthFile = process.env.BUTLER_APP_LOCAL_AUTH_FILE ?? join(data, "app", "runtime", "auth", "local-agent-auth.json");
function readSecret(path: string, key: string): string {
  const value = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)[key];
  if (typeof value !== "string" || !value.trim()) throw new Error("Required tunnel credential is missing.");
  return value.trim();
}

const proxy = await createTunnelProxyServer({
  listenHost: process.env.BUTLER_TUNNEL_PROXY_HOST ?? "127.0.0.1",
  listenPort: Number(process.env.BUTLER_TUNNEL_PROXY_PORT ?? "18766"),
  upstream: new URL(process.env.BUTLER_TUNNEL_PROXY_UPSTREAM ?? "http://127.0.0.1:18765"),
  auth: {
    get basicUsername() { return readSecret(authFile, "username"); },
    get basicPassword() { return readSecret(authFile, "password"); },
    get sessionSecret() { return readSecret(authFile, "session_secret"); },
    get upstreamBearerToken() { return readSecret(localAuthFile, "token"); },
    oneTimeLoginDirectory: process.env.BUTLER_TUNNEL_PROXY_LOGIN_DIRECTORY ?? join(data, "tunnel", "one-time-logins"),
  },
});
process.stdout.write(`Butler tunnel proxy listening on ${proxy.endpoint}\n`);
const stop = () => { void proxy.close().finally(() => process.exit(0)); };
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
