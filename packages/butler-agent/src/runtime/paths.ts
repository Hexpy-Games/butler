import { existsSync, realpathSync } from "fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "path";

/** Writable runtime root, independent of the executable/source location. */
export function butlerDataPath(explicit?: string): string {
  return resolve(explicit || process.env.BUTLER_DATA || join(homedir(), ".butler"));
}

export function isInsideProgramHome(path: string, programHome = process.env.BUTLER_HOME): boolean {
  if (!programHome) return false;
  const roots = [resolve(programHome)];
  if (existsSync(programHome)) roots.push(realpathSync(programHome));
  return roots.some((root) => {
    const suffix = relative(root, resolve(path));
    return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix));
  });
}

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
