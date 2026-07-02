import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createConversationProjectionReader,
  type ManagedConversationProjectionReader,
} from "../../../../agent/conversation/projection-reader.ts";
import {
  AppResponderTimeoutError,
  AppServerStore,
  AppStoreOperationError,
} from "../../application/store/app-server-store.ts";
import { apiError } from "../protocol/app-protocol.ts";
import {
  devCorsHeaders,
  normalizeDevCorsPolicy,
  withExtraHeaders,
} from "./dev-cors.ts";
import { normalizeLocalAuth } from "./local-auth.ts";
import { FixedWindowRateLimiter } from "./rate-limiter.ts";
import { routeRequest } from "./route-request.ts";
import { json, RequestError } from "./responses.ts";
import type {
  AppServerHandle,
  CreateAppServerOptions,
} from "./server-types.ts";

export type {
  AppServerHandle,
  CreateAppServerOptions,
  MessageRateLimitOptions,
} from "./server-types.ts";

const DEFAULT_RESPONDER_TIMEOUT_MS = 600_000;
// Bun rejects idleTimeout values above 255, so keep direct HTTP requests at
// Bun's maximum while the responder timeout budget remains configurable.
const MAX_BUN_IDLE_TIMEOUT_SECONDS = 255;

export function createAppServer(
  options: CreateAppServerOptions = {},
): AppServerHandle {
  const ownedConversationReader = createOwnedConversationReader(options);
  const store = createStore(
    options,
    options.conversationProjectionReader ?? ownedConversationReader?.reader,
  );
  const messageRateLimiter = new FixedWindowRateLimiter(
    options.messageRateLimit,
  );
  const responderTimeoutMs =
    options.responderTimeoutMs ?? DEFAULT_RESPONDER_TIMEOUT_MS;
  const devCorsPolicy = normalizeDevCorsPolicy(options.devCorsOrigin);
  const localAuth = normalizeLocalAuth(options.localAuth);
  const uiRoot = resolveUiRoot(options);
  let automationSchedulerRunning = false;

  const server = Bun.serve({
    port: options.port ?? 18765,
    hostname: options.hostname ?? "127.0.0.1",
    idleTimeout: bunIdleTimeoutSeconds(responderTimeoutMs),
    async fetch(request) {
      const corsHeaders = devCorsHeaders(request, devCorsPolicy);
      if (isCorsPreflight(request, corsHeaders)) {
        return corsPreflightResponse(corsHeaders);
      }
      try {
        const response = await routeRequest({
          request,
          store,
          uiRoot,
          responder: options.responder,
          responderTimeoutMs,
          messageRateLimiter,
          localAuth,
        });
        return withExtraHeaders(response, corsHeaders);
      } catch (error) {
        return errorResponse(error, corsHeaders);
      }
    },
  });

  const automationScheduler = createAutomationScheduler({
    store,
    responder: options.responder,
    responderTimeoutMs,
    intervalMs: options.automationSchedulerIntervalMs,
    isRunning: () => automationSchedulerRunning,
    setRunning: (running) => {
      automationSchedulerRunning = running;
    },
  });

  return {
    url: server.url.toString(),
    store,
    stop() {
      if (automationScheduler) clearInterval(automationScheduler);
      server.stop();
      store.close();
      ownedConversationReader?.close();
    },
  };
}

function createStore(
  options: CreateAppServerOptions,
  conversationProjectionReader?: CreateAppServerOptions["conversationProjectionReader"],
): AppServerStore {
  return new AppServerStore({
    dbPath: options.dbPath,
    butlerData: options.butlerData,
    butlerHome: options.butlerHome,
    appVersion: options.appVersion,
    appUpdateManifest: options.appUpdateManifest,
    serverUrl: options.serverUrl,
    bridgeMode: options.bridgeMode,
    projectWorkspaceRoot: options.projectWorkspaceRoot,
    folderSelectionSecret: options.folderSelectionSecret,
    serviceClient: options.serviceClient,
    conversationProjectionReader,
  });
}

function createOwnedConversationReader(
  options: CreateAppServerOptions,
): ManagedConversationProjectionReader | null {
  if (options.conversationProjectionReader || !options.butlerData) return null;
  return createConversationProjectionReader({ butlerData: options.butlerData });
}

function resolveUiRoot(options: CreateAppServerOptions): string {
  const uiBaseRoot = options.butlerHome ?? process.cwd();
  const packagedUiRoot = resolve(
    uiBaseRoot,
    "packages",
    "butler-agent",
    "resources",
    "app-client",
    "dist",
  );
  const builtUiRoot = resolve(
    uiBaseRoot,
    "packages",
    "butler-app",
    "client",
    "ui",
    "dist",
  );
  return (
    options.uiRoot ??
    (existsSync(packagedUiRoot)
      ? packagedUiRoot
      : existsSync(builtUiRoot)
        ? builtUiRoot
        : resolve(uiBaseRoot, "packages", "butler-app", "client", "ui"))
  );
}

function bunIdleTimeoutSeconds(responderTimeoutMs: number): number {
  return Math.min(
    MAX_BUN_IDLE_TIMEOUT_SECONDS,
    Math.max(30, Math.ceil(responderTimeoutMs / 1000)),
  );
}

function isCorsPreflight(
  request: Request,
  corsHeaders: Record<string, string>,
): boolean {
  return request.method === "OPTIONS" && Object.keys(corsHeaders).length > 0;
}

function corsPreflightResponse(corsHeaders: Record<string, string>): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders,
      "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "600",
    },
  });
}

function errorResponse(error: unknown, extraHeaders: HeadersInit): Response {
  if (error instanceof AppResponderTimeoutError) {
    return json(apiError(error.code, error.message), 504, extraHeaders);
  }
  if (error instanceof AppStoreOperationError) {
    return json(apiError(error.code, error.message), error.status, extraHeaders);
  }
  if (error instanceof RequestError) {
    return json(apiError(error.code, error.message), error.status, extraHeaders);
  }
  return json(apiError("internal_error", "Request failed."), 500, extraHeaders);
}

function createAutomationScheduler(input: {
  store: AppServerStore;
  responder: CreateAppServerOptions["responder"];
  responderTimeoutMs: number;
  intervalMs: CreateAppServerOptions["automationSchedulerIntervalMs"];
  isRunning: () => boolean;
  setRunning: (running: boolean) => void;
}): ReturnType<typeof setInterval> | null {
  if (input.intervalMs === false) return null;
  const intervalMs = Math.max(1000, input.intervalMs ?? 30_000);
  return setInterval(() => {
    if (input.isRunning()) return;
    input.setRunning(true);
    input.store
      .dispatchDueAutomations(input.responder, {
        responderTimeoutMs: input.responderTimeoutMs,
      })
      .catch((error) => {
        input.store.appendSafeServerEvent("automation.scheduler_error", {
          code:
            error instanceof Error
              ? "automation_scheduler_failed"
              : "automation_scheduler_unknown",
        });
      })
      .finally(() => {
        input.setRunning(false);
      });
  }, intervalMs);
}
