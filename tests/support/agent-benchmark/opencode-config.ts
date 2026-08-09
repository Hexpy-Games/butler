import { lstatSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { BenchmarkArmPlan } from "./contracts.ts";
import { safeEnvironment } from "./command.ts";

/** Controlled OpenCode policy: explicit deny-by-default plus the benchmark's
 * read/edit/glob/grep/web capability surface. Recommended-default never uses
 * this configuration. */
export const CONTROLLED_OPENCODE_CONFIG = {
  "$schema": "https://opencode.ai/config.json",
  permission: {
    "*": "deny",
    read: "allow",
    edit: { "*": "allow", ".benchmark-input/repository/**": "deny" },
    glob: "allow",
    grep: "allow",
    list: "allow",
    webfetch: "allow",
    websearch: "allow",
    bash: "deny",
    task: "deny",
    skill: "deny",
    question: "deny",
    external_directory: "deny",
    lsp: "deny",
  },
  plugin: [],
  instructions: [],
} as const;

/** Resolves the normal OpenCode data parent without reading its credentials. */
export function resolveOpenCodeAuthDataRoot(source: NodeJS.ProcessEnv = process.env): string | null {
  const configured = source.XDG_DATA_HOME?.trim();
  const home = source.HOME?.trim();
  const candidate = configured || (home ? join(home, ".local", "share") : "");
  if (!candidate || !isAbsolute(candidate)) return null;
  try {
    const resolved = resolve(candidate);
    if (!statSync(resolved).isDirectory()) return null;
    const authPath = join(resolved, "opencode", "auth.json");
    const authStat = lstatSync(authPath);
    return authStat.isFile() && authStat.size > 0 && authStat.size <= 1024 * 1024 ? resolved : null;
  } catch {
    return null;
  }
}

/** Builds controlled OpenCode env with isolated config/home/cache and normal auth data. */
export function controlledOpenCodeEnvironment(
  arm: Pick<BenchmarkArmPlan, "dataRoot" | "cacheRoot">,
  authDataRoot: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const dataRoot = resolve(arm.dataRoot);
  const cacheRoot = resolve(arm.cacheRoot);
  return safeEnvironment({
    HOME: join(dataRoot, "home"),
    XDG_CONFIG_HOME: join(dataRoot, "xdg-config"),
    XDG_DATA_HOME: authDataRoot,
    XDG_CACHE_HOME: join(cacheRoot, "xdg-cache"),
    OPENCODE_CONFIG_DIR: join(dataRoot, "opencode-config"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(CONTROLLED_OPENCODE_CONFIG),
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
  }, source);
}
