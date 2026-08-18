import type { ButlerServiceClient } from "../../../core/client.ts";
import type {
  AppMessageResponder,
  AppServerStore,
} from "../../application/store/app-server-store.ts";
import type { FixedWindowRateLimiter } from "./rate-limiter.ts";
import type { LocalAuthConfig } from "./local-auth.ts";
import type { ProviderQuotaMonitor } from "../../../../operations/metrics/provider-quota.ts";
import type { PrincipalAuthority } from "../../../../agent/btcc/authority/index.ts";

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
  serviceClient?: ButlerServiceClient;
  providerQuotaMonitor?: ProviderQuotaMonitor;
  messageRateLimit?: MessageRateLimitOptions;
  automationSchedulerIntervalMs?: number | false;
  /** Production composition-owned authority aggregate adapter. */
  authority?: PrincipalAuthority;
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
  serverShutdownSignal: AbortSignal;
  setRequestIdleTimeout(seconds: number): void;
  /** @internal Explicit test-support composition only. */
  responder?: AppMessageResponder;
  /** @internal Explicit test-support composition only. */
  responderTimeoutMs?: number;
  messageRateLimiter: FixedWindowRateLimiter;
  localAuth: LocalAuthConfig;
  butlerData: string;
  authority: PrincipalAuthority;
}

export interface AppRouteContext extends Omit<AppRouteRequest, "localAuth"> {
  url: URL;
}

export type AppRouteHandler = (
  context: AppRouteContext,
) => Promise<Response | null> | Response | null;
