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
  }>;
}

export interface FirstRunSetupBridge {
  status(): FirstRunSetupStatusView;
  diagnostics(): FirstRunSetupDiagnosticsView;
  cancel(): FirstRunSetupStatusView;
  start(): Promise<FirstRunSetupStatusView>;
}

export function createFirstRunSetupBridge(input: {
  ensureReady: () => Promise<void>;
  gatewayProfile?: "electron";
  readSettings: () => Promise<{
    bridge_mode?: string;
    gateway_profile?: string;
    server_url?: string;
  } | null | undefined>;
}): FirstRunSetupBridge;
