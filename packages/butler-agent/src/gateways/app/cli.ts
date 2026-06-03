import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  clearAppGatewayPid,
  isGatewayEnabled,
  resolveAppGatewayRuntimeConfig,
  writeAppGatewayPid,
} from "../../operations/gateway/registry.ts";
import { reclaimStaleAppGatewayPort } from "./port-claim.ts";
import { createAppServer } from "./server.ts";

const dataRoot =
  process.env.BUTLER_DATA ?? join(process.env.HOME ?? process.cwd(), ".butler");
if (!isGatewayEnabled(dataRoot, "app")) {
  console.error("Butler App gateway is disabled. Run `butler gateway enable app` to enable it.");
  process.exit(2);
}
const argvPort = Number(process.argv.find((arg) => arg.startsWith("--port="))?.split("=")[1]);
const appGatewayConfig = resolveAppGatewayRuntimeConfig({
  butlerData: dataRoot,
  argvPort: Number.isFinite(argvPort) ? argvPort : null,
});
const port = appGatewayConfig.port;
const hostname = appGatewayConfig.host;
const responderTimeoutMs = Number(
  process.env.BUTLER_APP_SERVER_RESPONDER_TIMEOUT_MS ?? "600000",
);
const messageRateLimitMax = Number(
  process.env.BUTLER_APP_SERVER_MESSAGE_RATE_LIMIT_MAX ?? "60",
);
const messageRateLimitWindowMs = Number(
  process.env.BUTLER_APP_SERVER_MESSAGE_RATE_LIMIT_WINDOW_MS ?? "60000",
);
const butlerHome =
  process.env.BUTLER_APP_BUTLER_HOME ??
  process.env.BUTLER_HOME ??
  process.cwd();
const dbPath =
  appGatewayConfig.dbPath ??
  join(dataRoot, "app-server", "butler-client.sqlite");
const projectWorkspaceRoot = process.env.BUTLER_PROJECT_WORKSPACE;
const folderSelectionSecret = process.env.BUTLER_PROJECT_FOLDER_TOKEN_SECRET;
const devCorsOrigin = process.env.BUTLER_APP_DEV_ORIGIN;
const bridgeMode =
  process.env.BUTLER_APP_SERVER_BRIDGE === "off" ? "external" : "local";
const shouldWritePidFile = process.env.BUTLER_APP_GATEWAY_PID_FILE !== "off";
mkdirSync(dirname(dbPath), { recursive: true });

const portClaim = reclaimStaleAppGatewayPort({
  port: Number.isFinite(port) ? port : 18765,
  hostname,
  butlerData: dataRoot,
  butlerHome,
});
if (portClaim.reclaimedPids.length > 0) {
  console.error(
    `Reclaimed stale Butler app gateway listener(s): ${portClaim.reclaimedPids.join(", ")}`,
  );
}

const app = createAppServer({
  dbPath,
  butlerData: dataRoot,
  butlerHome,
  serverUrl: `http://${hostname}:${Number.isFinite(port) ? port : 18765}`,
  bridgeMode,
  projectWorkspaceRoot,
  folderSelectionSecret,
  devCorsOrigin,
  port: Number.isFinite(port) ? port : 18765,
  hostname,
  responderTimeoutMs: Number.isFinite(responderTimeoutMs)
    ? responderTimeoutMs
    : 600000,
  messageRateLimit: {
    max: Number.isFinite(messageRateLimitMax) ? messageRateLimitMax : 60,
    windowMs: Number.isFinite(messageRateLimitWindowMs)
      ? messageRateLimitWindowMs
      : 60000,
  },
});

console.log(
  JSON.stringify({
    ok: true,
    service: "butler-app-server",
    url: app.url,
    dbConfigured: appGatewayConfig.dbConfigured,
  }),
);
if (shouldWritePidFile) writeAppGatewayPid(dataRoot, process.pid);
const keepAliveInterval = setInterval(() => {
  void app.url;
}, 60 * 60 * 1000);

process.on("SIGINT", () => {
  clearInterval(keepAliveInterval);
  if (shouldWritePidFile) clearAppGatewayPid(dataRoot);
  app.stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  clearInterval(keepAliveInterval);
  if (shouldWritePidFile) clearAppGatewayPid(dataRoot);
  app.stop();
  process.exit(0);
});
process.on("exit", () => {
  if (shouldWritePidFile) clearAppGatewayPid(dataRoot);
});
