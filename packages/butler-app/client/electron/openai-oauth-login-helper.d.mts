export interface OpenAIOAuthLoginHelper {
  command: string;
  args: string[];
  env: { BUTLER_DATA: string };
}

export interface ResolveOpenAIOAuthLoginHelperOptions {
  butlerData?: string;
  resourcesPath?: string;
  execPath?: string;
  platform?: NodeJS.Platform;
  isPackaged?: boolean;
  env?: Record<string, string | undefined>;
  resolveInstallation?: (options: {
    butlerData?: string;
    resourcesPath?: string;
    execPath?: string;
    platform?: NodeJS.Platform;
    isPackaged?: boolean;
    env?: Record<string, string | undefined>;
  }) => { command: string; args: string[]; env: { BUTLER_DATA: string } } | null;
}

export function resolveOpenAIOAuthLoginHelper(
  options?: ResolveOpenAIOAuthLoginHelperOptions,
): OpenAIOAuthLoginHelper | null;

export function resolveOpenAIAuthProfilePath(options: {
  butlerData: string;
  env?: Record<string, string | undefined>;
}): string;
