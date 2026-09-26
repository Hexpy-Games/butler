import { resolveNativeAgentInstallation } from "./bundled-native-agent.mjs";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function resolveOpenAIAuthProfilePath({ butlerData, env = process.env } = {}) {
  const dataRoot = nearestRealPath(butlerData);
  const configured = env.BUTLER_CODEX_AUTH_PROFILE || env.BUTLER_OPENAI_AUTH_PROFILE;
  const requested = configured
    ? (isAbsolute(configured) ? configured : join(dataRoot, configured))
    : join(dataRoot, "auth", "openai-codex.json");
  const path = nearestRealPath(requested);
  const inside = relative(dataRoot, path);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error("OpenAI auth profile path must be inside BUTLER_DATA.");
  }
  return path;
}

function nearestRealPath(path) {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch (error) {
    try {
      lstatSync(absolute);
      throw error;
    } catch (statError) {
      if (statError === error || statError?.code !== "ENOENT") throw error;
    }
    if (dirname(absolute) === absolute) throw error;
    return join(nearestRealPath(dirname(absolute)), absolute.slice(dirname(absolute).length + 1));
  }
}

/** Resolve the installed executable used by the short-lived OAuth child. */
export function resolveOpenAIOAuthLoginHelper({
  butlerData,
  resourcesPath = process.resourcesPath,
  execPath = process.execPath,
  platform = process.platform,
  isPackaged = true,
  env = process.env,
  resolveInstallation = resolveNativeAgentInstallation,
} = {}) {
  const installation = resolveInstallation({
    butlerData, resourcesPath, execPath, platform, isPackaged, env,
  });
  if (!installation) return null;
  return {
    command: installation.command,
    args: [...installation.args, "oauth-login"],
    env: { ...installation.env, BUTLER_DATA: resolve(butlerData) },
  };
}
