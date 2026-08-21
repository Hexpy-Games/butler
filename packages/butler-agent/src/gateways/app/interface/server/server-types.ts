import type { ButlerServiceClient } from "../../../core/client.ts";
import type {
  AppMessageResponder,
  AppServerStore,
} from "../../application/store/app-server-store.ts";
import type { FixedWindowRateLimiter } from "./rate-limiter.ts";
import type { LocalAuthConfig } from "./local-auth.ts";
import type { ProviderQuotaMonitor } from "../../../../operations/metrics/provider-quota.ts";
import type { PrincipalAuthority } from "../../../../agent/btcc/authority/index.ts";
import type { StewardObserverReader } from "../../domain/sessions/steward-observer.ts";

interface CreateAppServerBaseOptions {
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
  localAuth?: {
    required?: boolean;
    token?: string | null;
  };
}

/**
 * The canonical app server owns one authority/observer composition. Callers
 * may either omit both and let the server compose the SQLite adapters, or
 * inject the complete pair for an explicitly owned composition. A partial
 * pair is deliberately rejected by the type system.
 */
export type CreateAppServerOptions = CreateAppServerBaseOptions & (
  | {
      authority?: never;
      stewardObserver?: never;
    }
  | {
      authority: PrincipalAuthority;
      stewardObserver: StewardObserverReader;
    }
);

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
  stewardObserver: StewardObserverReader;
  serviceClient: ButlerServiceClient;
}

export interface AppRouteContext extends Omit<AppRouteRequest, "localAuth"> {
  url: URL;
}

export type AppRouteHandler = (
  context: AppRouteContext,
) => Promise<Response | null> | Response | null;
