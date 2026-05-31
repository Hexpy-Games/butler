import { existsSync } from "fs";
import { join } from "path";

export function butlerAgentPackageRoot(butlerHome: string): string {
  return join(butlerHome, "packages", "butler-agent");
}

export function butlerAgentSourcePath(butlerHome: string, ...parts: string[]): string {
  return join(butlerAgentPackageRoot(butlerHome), "src", ...parts);
}

export function butlerAgentScriptPath(butlerHome: string, ...parts: string[]): string {
  return join(butlerAgentPackageRoot(butlerHome), "scripts", ...parts);
}

export function butlerAgentResourcesPath(butlerHome: string, ...parts: string[]): string {
  const packagedPath = join(butlerAgentPackageRoot(butlerHome), "resources", ...parts);
  if (existsSync(packagedPath)) return packagedPath;
  return join(butlerHome, "resources", ...parts);
}
