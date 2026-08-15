import {
  writeTunnelProxyServiceConfigFromEnv,
} from "./tunnel-service-config.ts";

const butlerData = process.env.BUTLER_DATA?.trim();
if (!butlerData) {
  throw new Error("BUTLER_DATA is required to configure the tunnel proxy.");
}

const config = writeTunnelProxyServiceConfigFromEnv({ butlerData });
process.stdout.write(`${JSON.stringify({
  schema: config.schema,
  enabled: config.enabled,
  listen_host: config.listen_host,
  listen_port: config.listen_port,
}, null, 2)}\n`);
