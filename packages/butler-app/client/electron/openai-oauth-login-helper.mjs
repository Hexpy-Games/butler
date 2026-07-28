import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import {
  APP_MANAGED_RUNTIME_POINTER_SCHEMA,
  appManagedAgentPointerPath,
} from "./app-managed-runtime.mjs";

export function resolveOpenAIOAuthLoginHelper({
  butlerData,
  repoRoot,
  resourcesPath = process.resourcesPath,
  fallbackRuntime = "bun",
  platform = process.platform,
  allowBundledResourceFallback = true,
  allowDevelopmentFallback = true,
  fileExists = existsSync,
  readFile = readFileSync,
} = {}) {
  const candidates = [
    appManagedOAuthLoginHelper({ butlerData, platform, fileExists, readFile }),
    allowBundledResourceFallback
      ? bundledResourceOAuthLoginHelper({ resourcesPath, platform, fileExists })
      : null,
    allowDevelopmentFallback
      ? repoOAuthLoginHelper({ repoRoot, fallbackRuntime })
      : null,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!fileExists(candidate.scriptPath)) continue;
    if (candidate.runtimeMustExist && !fileExists(candidate.runtime)) continue;
    return {
      source: candidate.source,
      scriptPath: candidate.scriptPath,
      runtime: candidate.runtime,
      butlerHome: candidate.butlerHome,
    };
  }
  return null;
}

export function oauthScriptButlerHome(scriptPath) {
  return resolve(dirname(scriptPath), "../../..");
}

function runtimeExecutableName(platform) {
  return platform === "win32" ? "bun.exe" : "bun";
}

function appManagedOAuthLoginHelper({ butlerData, platform, fileExists, readFile }) {
  if (!butlerData) return null;
  const pointerPath = appManagedAgentPointerPath(butlerData);
  if (!fileExists(pointerPath)) return null;
  let pointer;
  try {
    pointer = JSON.parse(readFile(pointerPath, "utf8"));
  } catch {
    return null;
  }
  const runtimeHome = appManagedRuntimeHome(butlerData, pointer);
  if (!runtimeHome) return null;
  return {
    source: "app-managed",
    scriptPath: join(
      runtimeHome,
      "packages",
      "butler-agent",
      "scripts",
      "openai-oauth-login.ts",
    ),
    runtime: join(
      runtimeHome,
      "packages",
      "butler-agent",
      "resources",
      "runtime",
      "bin",
      runtimeExecutableName(platform),
    ),
    butlerHome: runtimeHome,
    runtimeMustExist: true,
  };
}

function appManagedRuntimeHome(butlerData, pointer) {
  if (
    pointer?.schema !== APP_MANAGED_RUNTIME_POINTER_SCHEMA ||
    pointer.product !== "butler-app" ||
    pointer.gateway_profile !== "electron" ||
    typeof pointer.runtime_home !== "string" ||
    !pointer.runtime_home.trim() ||
    isAbsolute(pointer.runtime_home)
  ) {
    return null;
  }
  const normalized = normalize(pointer.runtime_home);
  if (normalized === "." || normalized.startsWith("..")) return null;
  return join(butlerData, normalized);
}

function bundledResourceOAuthLoginHelper({ resourcesPath, platform, fileExists }) {
  if (!resourcesPath) return null;
  const resourceRoot = join(resourcesPath, "bundled-agent");
  if (!fileExists(resourceRoot)) return null;
  return {
    source: "bundled-resource",
    scriptPath: join(
      resourceRoot,
      "packages",
      "butler-agent",
      "scripts",
      "openai-oauth-login.ts",
    ),
    runtime: join(resourceRoot, "runtime", "bin", runtimeExecutableName(platform)),
    butlerHome: resourceRoot,
    runtimeMustExist: true,
  };
}

function repoOAuthLoginHelper({ repoRoot, fallbackRuntime }) {
  if (!repoRoot) return null;
  const scriptPath = resolve(
    repoRoot,
    "packages",
    "butler-agent",
    "scripts",
    "openai-oauth-login.ts",
  );
  return {
    source: "repo",
    scriptPath,
    runtime: fallbackRuntime || "bun",
    butlerHome: oauthScriptButlerHome(scriptPath),
    runtimeMustExist: false,
  };
}
