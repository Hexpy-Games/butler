import {
  createServer,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  normalizeTunnelProxyConfig,
  type TunnelProxyConfig,
} from "./tunnel-http-proxy-config.ts";
import {
  handleTunnelProxyRequest,
  type TunnelProxyRequestHandle,
} from "./tunnel-http-proxy-request.ts";

export interface TunnelProxyServer {
  readonly server: Server;
  readonly endpoint: string;
  activeRequests(): number;
  close(): Promise<void>;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/**
 * Own the public HTTP listener and active request registry. Per-request
 * authentication, relay buffering, and downstream/upstream teardown live in
 * `tunnel-http-proxy-request.ts`, leaving this module responsible only for
 * server lifecycle and aggregate shutdown.
 */
export async function createTunnelProxyServer(
  input: TunnelProxyConfig,
): Promise<TunnelProxyServer> {
  const config = normalizeTunnelProxyConfig(input);
  const active = new Set<TunnelProxyRequestHandle>();
  let shuttingDown = false;

  const server = createServer((clientRequest, clientResponse) => {
    if (shuttingDown) {
      clientResponse.writeHead(503, { "cache-control": "no-store" });
      clientResponse.end("Tunnel is shutting down.\n");
      return;
    }
    handleTunnelProxyRequest({
      config,
      clientRequest,
      clientResponse,
      registerActive: (handle) => active.add(handle),
      unregisterActive: (handle) => active.delete(handle),
    });
  });

  await listen(server, config.listenPort, config.listenHost);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Tunnel proxy did not expose a TCP address.");
  }
  const addressInfo = address as AddressInfo;
  return {
    server,
    endpoint: `http://${addressInfo.address}:${addressInfo.port}`,
    activeRequests: () => active.size,
    close: async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      for (const request of [...active]) request.terminate();
      await closeServer(server);
    },
  };
}
