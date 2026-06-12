export const APP_MANAGED_RUNTIME_SCHEMA: "butler.app-managed-agent-runtime.v1";
export const APP_MANAGED_RUNTIME_POINTER_SCHEMA:
  "butler.app-managed-agent-runtime-pointer.v1";

export function appManagedAgentPointerPath(butlerData: string): string;

export function resolveBundledAgentResourceRoot(input?: {
  env?: Record<string, string | undefined>;
  resourcesPath?: string;
}): string | null;

export function activateAppManagedAgentRuntime(input: {
  butlerData: string;
  resourceRoot: string;
  now?: () => Date;
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

export function resolveAppManagedGatewayCommand(input?: {
  butlerData: string;
  env?: Record<string, string | undefined>;
  resourcesPath?: string;
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
