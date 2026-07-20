export interface OpenAIOAuthLoginHelper {
  source: "app-managed" | "bundled-resource" | "repo";
  scriptPath: string;
  runtime: string;
  butlerHome: string;
}

export interface ResolveOpenAIOAuthLoginHelperOptions {
  butlerData?: string;
  repoRoot?: string;
  resourcesPath?: string;
  fallbackRuntime?: string;
  platform?: NodeJS.Platform;
  allowBundledResourceFallback?: boolean;
  allowDevelopmentFallback?: boolean;
  fileExists?: (path: string) => boolean;
  readFile?: (path: string, encoding: "utf8") => string;
}

export function resolveOpenAIOAuthLoginHelper(
  options?: ResolveOpenAIOAuthLoginHelperOptions,
): OpenAIOAuthLoginHelper | null;

export function oauthScriptButlerHome(scriptPath: string): string;
