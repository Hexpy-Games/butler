export interface FirstRunSetupStatusView {
  phase: "idle" | "checking" | "ready" | "failed" | "cancelled";
  status_label: string;
  diagnostics_available: boolean;
  error_code?: string;
}

export interface FirstRunSetupDiagnosticsView {
  generated_at: string;
  phase: FirstRunSetupStatusView["phase"];
  checks: Array<{
    id: string;
    label: string;
    status: "pending" | "passed" | "failed" | "cancelled";
  }>;
  errors: Array<{
    code: string;
    message: string;
    details?: unknown;
  }>;
}

export interface FirstRunSetupBridge {
  status(): FirstRunSetupStatusView;
  diagnostics(): FirstRunSetupDiagnosticsView;
  cancel(): FirstRunSetupStatusView;
  start(input?: { mode?: "check" | "repair" }): Promise<FirstRunSetupStatusView>;
}

export interface FirstRunServiceControlBridge {
  getAgentServiceStatus?: () => Promise<unknown> | unknown;
  installAgentService?: (request?: unknown) => Promise<unknown> | unknown;
  startAgentService?: (request?: unknown) => Promise<unknown> | unknown;
  readAgentServiceDiagnostics?: () => Promise<unknown> | unknown;
}

export function resolveFirstRunServiceControl(input: {
  usesAppForegroundLifecycle: boolean;
  serviceControl: FirstRunServiceControlBridge;
}): FirstRunServiceControlBridge | null;

export function createFirstRunSetupBridge(input: {
  ensureReady: () => Promise<void>;
  gatewayProfile?: "electron";
  readRuntimeDiagnostics?: () => {
    phase?: string;
    bundled_agent?: {
      source?: string;
      version_configured?: boolean;
    };
    local_auth?: {
      required?: boolean;
      token_configured?: boolean;
    };
  };
  repairRuntime?: (() => Promise<void>) | null;
  serviceControl?: FirstRunServiceControlBridge | null;
  gatewayReadyPollAttempts?: number;
  gatewayReadyPollDelayMs?: number;
  serviceReadyPollAttempts?: number;
  serviceReadyPollDelayMs?: number;
  sleepMs?: (ms: number) => Promise<void>;
  readSettings: () => Promise<{
    bridge_mode?: string;
    gateway_profile?: string;
    server_url?: string;
  } | null | undefined>;
}): FirstRunSetupBridge;
