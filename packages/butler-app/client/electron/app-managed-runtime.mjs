import {
  resolveBundledNativeAgentCommand,
  resolveNativeAgentInstallation,
} from "./bundled-native-agent.mjs";

export function resolveAppManagedGatewayCommand({
  butlerData,
  env = process.env,
  resourcesPath = process.resourcesPath,
  platform = process.platform,
  execPath = process.execPath,
  isPackaged = true,
} = {}) {
  return resolveNativeAgentInstallation({
    butlerData, env, resourcesPath, platform, execPath, isPackaged,
  });
}

export function resolveAppManagedForegroundCommand({
  butlerData,
  resourcesPath = process.resourcesPath,
  platform = process.platform,
  execPath = process.execPath,
  isPackaged = true,
  env = process.env,
  onProgress = null,
} = {}) {
  const command = resolveBundledNativeAgentCommand({
    butlerData, resourcesPath, execPath, platform, isPackaged, env,
  });
  onProgress?.("runtime_resource_resolved");
  onProgress?.("runtime_native_payload_verified");
  return command;
}
