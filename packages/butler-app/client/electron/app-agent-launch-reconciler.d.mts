export function reconcileAgentServiceOnAppLaunch(options?: {
  serviceControl?: {
    getAgentServiceStatus?: () => unknown | Promise<unknown>;
    installAgentService?: (request?: unknown) => unknown | Promise<unknown>;
    startAgentService?: (request?: unknown) => unknown | Promise<unknown>;
    restartAgentService?: (request?: unknown) => unknown | Promise<unknown>;
  } | null;
  enabled?: boolean;
  runtimeCurrent?: () =>
    | boolean
    | {
        current?: boolean;
        expectedVersion?: string;
        activeVersion?: string;
        reason?: string;
      }
    | Promise<
        | boolean
        | {
            current?: boolean;
            expectedVersion?: string;
            activeVersion?: string;
            reason?: string;
          }
      >;
  source?: string;
  debug?: boolean;
  logger?: {
    warn?: (...args: unknown[]) => void;
  } | null;
}): Promise<{
  attempted: boolean;
  reason: string;
  initialStatus: unknown;
  finalStatus: unknown;
  runtimeStatus?: unknown;
  actionResult?: unknown;
  error?: string;
}>;
