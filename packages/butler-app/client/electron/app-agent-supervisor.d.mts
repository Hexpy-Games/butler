import type {
  AgentStopIntent,
  AgentStopIntentRespawner,
  NativeServiceInstance,
} from "./app-agent-stop-intent.mjs";

export type AgentRuntimeState =
  | "running"
  | "starting"
  | "stopped"
  | "restarting"
  | "restart_failed"
  | "failed"
  | "idle";

export const APP_LOCAL_AUTH_SCHEMA: "butler.app-local-agent-auth.v1";

export function appLocalAuthPath(butlerData: string): string;

export function readAppLocalAuth(input: { butlerData: string }): {
  filePath: string;
  created: false;
  token: string;
} | null;

export function prepareAppLocalAuth(input: {
  butlerData: string;
  now?: () => Date;
  generateToken?: () => string;
}): {
  filePath: string;
  created: boolean;
  token: string;
};

export function buildBundledAgentSupervisorEnv(input: {
  baseEnv?: Record<string, string | undefined>;
  gatewayEnv?: Record<string, string | undefined>;
  port: number;
  serverUrl: string;
  appVersion?: string | null;
  rendererOrigin: string;
  explicitUiUrl?: string | null;
  projectFolderTokenSecret?: string | null;
  localAuth: { filePath: string; token: string };
}): Record<string, string | undefined>;

export function createBundledAgentSupervisor(input: {
  butlerData: string;
  resolveGateway: () => {
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string | undefined>;
    appManaged?: boolean;
    bundledAgentVersion?: string;
    commitActivation?: () => void;
    invalidateRuntimeReceipt?: () => void;
    rollbackActivation?: (error: Error) => void;
    containmentKind?: string;
    containmentVerified?: boolean;
    ownerDeathGuaranteed?: boolean;
    recordsProcessGroupId?: boolean;
  };
  spawnProcess: (
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env: Record<string, string | undefined>;
      stdio: string;
    },
  ) => {
    pid?: number;
    once(event: "error", listener: (error: Error) => void): unknown;
    once(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
    kill(signal: string): unknown;
  };
  healthCheck: (
    localAuth?: { filePath: string; created: boolean; token: string } | null,
  ) => boolean | Promise<boolean>;
  readinessCheck?: (
    localAuth?: { filePath: string; created: boolean; token: string } | null,
    activeGateway?: Record<string, unknown> | null,
  ) => boolean | Promise<boolean>;
  isPortAvailable: (port: number) => boolean | Promise<boolean>;
  findAvailablePort: (startPort: number) => number | Promise<number>;
  updatePort: (port: number) => void;
  getPort: () => number;
  getServerUrl: () => string;
  getAppVersion?: () => string | null;
  getRendererOrigin: () => string;
  getLocalPagePreviewUrl?: () => string | null;
  explicitServerUrl?: string | null;
  explicitUiUrl?: string | null;
  projectFolderTokenSecret?: string | null;
  baseEnv?: Record<string, string | undefined>;
  sleepMs?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  setKillTimer?: (fn: () => void, ms: number) => unknown;
  clearKillTimer?: (timer: unknown) => void;
  startupAttempts?: number;
  startupDelayMs?: number;
  startupTimeoutMs?: number | null;
  killTimeoutMs?: number;
  probeTimeoutMs?: number;
  stdio?: string;
  onGatewayStarting?: (gateway: {
    env?: Record<string, string | undefined>;
    bundledAgentVersion?: string;
  }) => void;
  onUnexpectedExit?: (exit: { code: number | null; signal: string | null }) => void;
  readStopIntent?: () => AgentStopIntent | null;
  writeStopIntent?: (intent: {
    reason: "stop" | "restart";
    pid: number;
    instanceId: string;
    requestedBy: "app";
    respawnBy: "app" | null;
  }) => unknown;
  retractStopIntent?: (target: { pid: number; instanceId: string }) => unknown;
  readInstanceRecord?: () => NativeServiceInstance | null;
  isProcessAlive?: (pid: number) => boolean;
  restartReconnectTimeoutMs?: number;
  externalPollMs?: number;
  schedulePoll?: (fn: () => unknown, ms: number) => unknown;
  cancelPoll?: (timer: unknown) => void;
  onIntentionalExit?: (event: {
    reason: "stop" | "restart";
    requestedBy: "cli" | "app" | "mcp";
    /** `app`: this App respawns the Agent itself; otherwise it waits and reconnects. */
    respawnBy: AgentStopIntentRespawner | null;
    exit: { code: number | null; signal: string | null };
  }) => void;
  onExternalAttach?: (event: {
    pid: number;
    instanceId: string;
    port: number;
    appSupervised: boolean;
  }) => void;
  onRestartReconnectFailed?: () => void;
}): {
  agentState(): {
    state: AgentRuntimeState;
    requested_by: "cli" | "app" | "mcp" | null;
    raw_text_included: false;
  };
  diagnostics(): {
    phase: string;
    pid: number | null;
    binding: { host: "127.0.0.1"; port: number };
    containment: {
      kind: string;
      verified: boolean;
      owner_death_guaranteed: boolean;
      raw_text_included: false;
    };
    lifecycle_patch: Record<string, unknown>;
    bundled_agent: {
      source: "app-managed" | "development";
      version: string | null;
      version_configured: boolean;
    };
    local_auth: {
      required: true;
      file_configured: boolean;
      token_configured: boolean;
      raw_text_included: false;
    };
    last_error_code: string | null;
    last_exit: { code: number | null; signal: string | null } | null;
    agent_state: AgentRuntimeState;
    external_agent_attached: boolean;
    raw_text_included: false;
  };
  authHeaders(): Record<string, string>;
  /** Re-reads the data-folder token file; true when the token changed. */
  reloadLocalAuth(): boolean;
  ensureReady(): Promise<void>;
  repair(): Promise<void>;
  restart(): Promise<void>;
  resume(): Promise<void>;
  start(): Promise<void>;
  stop(input?: { wait?: boolean; reason?: "stop" | "restart" }): Promise<{
    stopped: boolean;
    containment_released: boolean;
    raw_text_included: false;
  }>;
};
