import {
  createServer as httpCreateServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import type {
  EmbedHealthSnapshot,
  EmbeddingLifecycle,
} from "./embed-lifecycle.ts";

export interface EmbedHealthServerHandle {
  stop(): void;
  ready: Promise<void>;
  port: () => number | null;
}

export function healthPortDiscoveryPath(socketPath: string): string {
  return `${socketPath}.health-port`;
}

export function healthSnapshot(
  socketPath: string,
  lifecycle?: EmbeddingLifecycle,
  queue?: {
    queuedRequests: number;
    queuedBytes: number;
    maxQueuedRequests: number;
    maxQueuedBytes: number;
  },
): EmbedHealthSnapshot {
  const health = lifecycle?.health() ?? {
    status: "ready" as const,
    model_loaded: false,
    active_requests: 0,
    idle_recycle_ms: 0,
  };
  return {
    ...health,
    socket: socketPath,
    uptime: process.uptime(),
    ...(queue ? {
      queued_requests: queue.queuedRequests,
      queued_bytes: queue.queuedBytes,
      max_queued_requests: queue.maxQueuedRequests,
      max_queued_bytes: queue.maxQueuedBytes,
    } : {}),
  };
}

export function createHealthServer({
  healthPort,
  socketPath,
  lifecycle,
  queue,
  log = (message: string) => console.log(message),
  portProbeLimit = 16,
}: {
  healthPort: number;
  socketPath: string;
  lifecycle?: EmbeddingLifecycle;
  queue?: () => {
    queuedRequests: number;
    queuedBytes: number;
    maxQueuedRequests: number;
    maxQueuedBytes: number;
  };
  log?: (message: string) => void;
  /** Number of deterministic ports to probe after an occupied configured port. */
  portProbeLimit?: number;
}): EmbedHealthServerHandle {
  let boundPort: number | null = null;
  let stopped = false;
  let healthServer: ReturnType<typeof httpCreateServer> | null = null;
  let probeCount = 0;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const handleRequest = (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== "/health") {
      res.writeHead(404);
      res.end();
      return;
    }
    const snapshot = healthSnapshot(socketPath, lifecycle, queue?.());
    const statusCode = snapshot.status === "ready" || snapshot.status === "busy" ? 200 : 503;
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(snapshot));
  };
  const discoveryPath = healthPortDiscoveryPath(socketPath);
  const normalizedProbeLimit = Number.isInteger(portProbeLimit) && portProbeLimit >= 0
    ? portProbeLimit
    : 16;
  const fail = (error: unknown): void => {
    boundPort = null;
    lifecycle?.markUnavailable?.();
    rejectReady(error instanceof Error ? error : new Error(String(error)));
  };
  const writeDiscovery = (port: number): void => {
    try {
      writeFileSync(discoveryPath, `${port}\n`, { mode: 0o600 });
      chmodSync(discoveryPath, 0o600);
    } catch (error) {
      log(`embed-server health port discovery unavailable: ${String(error)}`);
    }
  };
  const bind = (candidate: number): void => {
    if (stopped) return;
    const server = httpCreateServer(handleRequest);
    healthServer = server;
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && !stopped && probeCount < normalizedProbeLimit) {
        probeCount += 1;
        const nextPort = candidate === 0 ? 0 : candidate >= 65_535 ? 1 : candidate + 1;
        log(`embed-server health port ${candidate} is occupied; probing ${nextPort}`);
        healthServer = null;
        bind(nextPort);
        return;
      }
      fail(error);
    });
    server.listen(candidate, "127.0.0.1", () => {
      const address = server.address();
      boundPort = typeof address === "object" && address ? address.port : candidate;
      writeDiscovery(boundPort);
      log(`embed-server health check on http://127.0.0.1:${boundPort}/health`);
      resolveReady();
    });
  };
  bind(healthPort);
  return {
    ready,
    port: () => boundPort,
    stop: () => {
      if (stopped) return;
      stopped = true;
      boundPort = null;
      try {
        rmSync(discoveryPath, { force: true });
      } catch {}
      healthServer?.close();
      healthServer = null;
    },
  };
}
