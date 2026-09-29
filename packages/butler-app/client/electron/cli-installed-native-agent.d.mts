export interface NativeAgentInstallation {
  command: string;
  args: string[];
  cwd: string;
  appManaged: true;
  bundledAgentVersion: string | null;
  env: Record<string, string>;
}

export function cliAgentHome(input?: {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  home?: string;
}): string | null;

export function resolveCliInstalledAgent(input?: {
  butlerData?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: Record<string, string | undefined>;
  home?: string;
}): NativeAgentInstallation | null;

export function preferNewerAgent<T extends { bundledAgentVersion: string | null }>(
  bundled: T,
  cliInstalled: T | null,
): T;

export function versionNewer(available: string, current: string): boolean;
