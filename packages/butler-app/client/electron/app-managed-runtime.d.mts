export const APP_MANAGED_RUNTIME_SCHEMA: "butler.app-managed-agent-runtime.v1";
export const APP_MANAGED_RUNTIME_POINTER_SCHEMA:
  "butler.app-managed-agent-runtime-pointer.v1";
export const APP_MANAGED_RUNTIME_UPDATE_TRANSACTION_SCHEMA:
  "butler.app-managed-agent-runtime-update-transaction.v1";

export function appManagedAgentPointerPath(butlerData: string): string;
export function appManagedAgentUpdateTransactionPath(butlerData: string): string;
export function appManagedAgentCandidateBootTokenPath(butlerData: string): string;

export interface AppManagedAgentRuntimePointer {
  schema: typeof APP_MANAGED_RUNTIME_POINTER_SCHEMA;
  product: "butler-app";
  gateway_profile: "electron";
  version: string;
  runtime_home: string;
  [key: string]: unknown;
}

export interface AppManagedAgentRuntimeUpdateTransaction {
  schema: typeof APP_MANAGED_RUNTIME_UPDATE_TRANSACTION_SCHEMA;
  generation: string;
  status:
    | "restart_required"
    | "candidate_ready"
    | "ready"
    | "rollback";
  previous_active_pointer: AppManagedAgentRuntimePointer;
  active_pointer: AppManagedAgentRuntimePointer;
  candidate_pointer: AppManagedAgentRuntimePointer;
  candidate_digest: string;
  candidate_boot_token_hash: string;
  readiness_proof: Record<string, unknown> | null;
  started_at: string;
  updated_at: string;
  last_error: string | null;
  raw_text_included: false;
}

export function beginAppManagedAgentRuntimeUpdate(input: {
  butlerData: string;
  candidatePointer: AppManagedAgentRuntimePointer;
  candidateDigest: string;
  now?: () => Date;
  generateToken?: () => string;
}): AppManagedAgentRuntimeUpdateTransaction;

export function readAppManagedAgentRuntimeUpdateTransaction(
  butlerData: string,
): AppManagedAgentRuntimeUpdateTransaction | null;

export function recoverAppManagedAgentRuntimeUpdateTransaction(input: {
  butlerData: string;
  now?: () => Date;
}): AppManagedAgentRuntimeUpdateTransaction | null;

export function consumeAppManagedAgentCandidateBootToken(input: {
  butlerData: string;
  generation: string;
  candidateDigest: string;
  token: string;
}): {
  generation: string;
  candidate_pointer: AppManagedAgentRuntimePointer;
  candidate_digest: string;
  raw_text_included: false;
};

export function markAppManagedAgentRuntimeCandidateReady(input: {
  butlerData: string;
  generation: string;
  readinessProof?: Record<string, unknown>;
  now?: () => Date;
}): AppManagedAgentRuntimeUpdateTransaction;

export function promoteAppManagedAgentRuntimeCandidate(input: {
  butlerData: string;
  generation: string;
  now?: () => Date;
}): AppManagedAgentRuntimeUpdateTransaction;

export function rollbackAppManagedAgentRuntimeUpdate(input: {
  butlerData: string;
  generation: string;
  error?: Error;
  now?: () => Date;
}): AppManagedAgentRuntimeUpdateTransaction;

export function resolveBundledAgentResourceRoot(input?: {
  env?: Record<string, string | undefined>;
  resourcesPath?: string;
}): string | null;

export function activateAppManagedAgentRuntime(input: {
  butlerData: string;
  resourceRoot: string;
  now?: () => Date;
  platform?: NodeJS.Platform;
}): {
  runtimeHome: string;
  runtimeHomeLabel: string;
  version: string;
  pointerPath: string;
  activated: boolean;
  previousRuntimePath: string | null;
};

export function prepareAppManagedAgentRuntime(input: {
  butlerData: string;
  resourceRoot: string;
  now?: () => Date;
  platform?: NodeJS.Platform;
}): {
  runtimeHome: string;
  runtimeHomeLabel: string;
  version: string;
  pointerPath: string;
  activated: boolean;
  previousRuntimePath: string | null;
  commitActivation: () => void;
  rollbackActivation: (error?: Error) => void;
};

export function windowsRuntimeSignatureIssue(runtimePayloadHome: string): string | null;

export function resolveAppManagedGatewayCommand(input?: {
  butlerData: string;
  env?: Record<string, string | undefined>;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
}): {
  command: string;
  args: string[];
  cwd: string;
  appManaged: true;
  bundledAgentVersion: string;
  env: Record<string, string>;
  commitActivation: () => void;
  rollbackActivation: (error?: Error) => void;
} | null;

export function resolveAppManagedForegroundCommand(input?: {
  butlerData: string;
  env?: Record<string, string | undefined>;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
}): {
  command: string;
  args: string[];
  cwd: string;
  stdio: ["pipe", "inherit", "inherit"];
  detached: true;
  appManaged: true;
  foregroundHost: true;
  bundledAgentVersion: string;
  env: Record<string, string>;
  commitActivation: () => void;
  rollbackActivation: (error?: Error) => void;
} | null;
