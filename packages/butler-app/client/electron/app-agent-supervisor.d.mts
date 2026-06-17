export const APP_LOCAL_AUTH_SCHEMA: "butler.app-local-agent-auth.v1";

export function appLocalAuthPath(butlerData: string): string;

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
    rollbackActivation?: (error: Error) => void;
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
  ) => boolean | Promise<boolean>;
  isPortAvailable: (port: number) => boolean | Promise<boolean>;
  findAvailablePort: (startPort: number) => number | Promise<number>;
  updatePort: (port: number) => void;
  getPort: () => number;
  getServerUrl: () => string;
  getAppVersion?: () => string | null;
  getRendererOrigin: () => string;
  explicitServerUrl?: string | null;
  explicitUiUrl?: string | null;
  projectFolderTokenSecret?: string | null;
  baseEnv?: Record<string, string | undefined>;
  sleepMs?: (ms: number) => Promise<void>;
  setKillTimer?: (fn: () => void, ms: number) => unknown;
  clearKillTimer?: (timer: unknown) => void;
  startupAttempts?: number;
  startupDelayMs?: number;
  killTimeoutMs?: number;
  probeTimeoutMs?: number;
  stdio?: string;
}): {
  diagnostics(): {
    phase: string;
    pid: number | null;
    binding: { host: "127.0.0.1"; port: number };
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
    raw_text_included: false;
  };
  authHeaders(): Record<string, string>;
  ensureReady(): Promise<void>;
  restart(): Promise<void>;
  start(): Promise<void>;
  stop(input?: { wait?: boolean }): Promise<void>;
};
