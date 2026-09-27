export interface NativeAgentLaunchCommand {
  command: string;
  args: string[];
  cwd: string;
  appManaged: true;
  bundledAgentVersion: string | null;
  env: Record<string, string>;
}

export function resolveAppManagedGatewayCommand(input?: {
  butlerData: string;
  env?: Record<string, string | undefined>;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  execPath?: string;
  isPackaged?: boolean;
}): NativeAgentLaunchCommand;

export function resolveAppManagedForegroundCommand(input?: {
  butlerData: string;
  env?: Record<string, string | undefined>;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  execPath?: string;
  isPackaged?: boolean;
  onProgress?: ((stage: string) => void) | null;
}): NativeAgentLaunchCommand & {
  stdio: ["pipe", "inherit", "inherit"];
  detached: true;
  foregroundHost: true;
  containmentKind: "posix_process_group";
  containmentVerified: true;
  ownerDeathGuaranteed: false;
  recordsProcessGroupId: true;
};
