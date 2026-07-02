import type { ButlerServiceClient } from "../../../core/client.ts";
import type { ConversationProjectionReader } from "../../../../agent/conversation/types.ts";
import type {
  AppMessageResponder,
  AppServerStore,
} from "../../application/store/app-server-store.ts";
import type { FixedWindowRateLimiter } from "./rate-limiter.ts";
import type { LocalAuthConfig } from "./local-auth.ts";

export interface CreateAppServerOptions {
  dbPath?: string;
  butlerData?: string;
  butlerHome?: string;
  appVersion?: string;
  appUpdateManifest?: string;
  serverUrl?: string;
  bridgeMode?: "local" | "external";
  projectWorkspaceRoot?: string;
  folderSelectionSecret?: string;
  port?: number;
  hostname?: string;
  uiRoot?: string;
  devCorsOrigin?: string;
  responder?: AppMessageResponder;
  responderTimeoutMs?: number;
  serviceClient?: ButlerServiceClient;
  conversationProjectionReader?: ConversationProjectionReader;
  messageRateLimit?: MessageRateLimitOptions;
  automationSchedulerIntervalMs?: number | false;
  localAuth?: {
    required?: boolean;
    token?: string | null;
  };
}

export interface MessageRateLimitOptions {
  max?: number;
  windowMs?: number;
}

export interface AppServerHandle {
  url: string;
  stop(): void;
  store: AppServerStore;
}

export interface AppRouteRequest {
  request: Request;
  store: AppServerStore;
  uiRoot: string;
  responder?: AppMessageResponder;
  responderTimeoutMs: number;
  messageRateLimiter: FixedWindowRateLimiter;
  localAuth: LocalAuthConfig;
}

export interface AppRouteContext extends Omit<AppRouteRequest, "localAuth"> {
  url: URL;
}

export type AppRouteHandler = (
  context: AppRouteContext,
) => Promise<Response | null> | Response | null;
