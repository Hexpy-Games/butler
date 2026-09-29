import type { NativeAgentInstallation } from "./cli-installed-native-agent.mjs";

interface ResolveInput {
  butlerData?: string;
  resourcesPath?: string;
  execPath?: string;
  platform?: NodeJS.Platform;
  isPackaged?: boolean;
  env?: Record<string, string | undefined>;
}

export function resolveBundledNativeAgentInstallation(
  input?: ResolveInput,
): NativeAgentInstallation | null;

/** The newer of the bundled Agent and a CLI-installed one (`AGENT_HOME/current`). */
export function resolveNativeAgentInstallation(input?: ResolveInput): NativeAgentInstallation;

export function resolveBundledNativeAgentCommand(input?: ResolveInput): NativeAgentInstallation & {
  stdio: string[];
  detached: boolean;
  foregroundHost: boolean;
  containmentKind: string;
  containmentVerified: boolean;
  ownerDeathGuaranteed: boolean;
  recordsProcessGroupId: boolean;
};
