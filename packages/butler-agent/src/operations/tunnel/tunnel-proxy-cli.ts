import { startTunnelProxyFromEnv } from "./tunnel-http-proxy.ts";

const proxy = await startTunnelProxyFromEnv();
process.stdout.write(`Butler tunnel proxy listening on ${proxy.endpoint}\n`);

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  void proxy.close().finally(() => process.exit(0));
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
