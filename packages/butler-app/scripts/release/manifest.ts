import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type AppReleasePlatform =
  | "darwin-arm64"
  | "linux-x64"
  | "linux-arm64"
  | "win32-x64";

export interface AppReleaseVersionBaseline {
  version?: string | null;
  bundledAgentVersion?: string | null;
}

export interface AppComponentVersions {
  app: string;
  bundledAgent: string;
}

export function readAppComponentVersions(root: string): AppComponentVersions {
  const electronPkg = JSON.parse(readFileSync(
    join(root, "packages", "butler-app", "client", "electron", "package.json"),
    "utf8",
  )) as { version?: unknown };
  const agentVersionPath = join(root, "VERSION");
  return {
    app: String(electronPkg.version ?? ""),
    bundledAgent: existsSync(agentVersionPath)
      ? readFileSync(agentVersionPath, "utf8").trim()
      : String(electronPkg.version ?? ""),
  };
}

export function validateAppReleaseVersionCoupling(
  current: AppReleaseVersionBaseline,
  previous?: AppReleaseVersionBaseline | null,
): string[] {
  if (!previous) return [];
  const currentVersion = current.version?.trim();
  const currentBundledAgentVersion = current.bundledAgentVersion?.trim();
  const previousVersion = previous.version?.trim();
  const previousBundledAgentVersion = previous.bundledAgentVersion?.trim();
  if (!currentVersion || !currentBundledAgentVersion || !previousVersion) {
    return ["app release version coupling requires app version and bundled Agent version"];
  }
  if (!previousBundledAgentVersion) {
    return currentVersion === previousVersion
      ? ["app release version must change when previous bundled Agent version is unavailable"]
      : [];
  }
  if (currentBundledAgentVersion !== previousBundledAgentVersion && currentVersion === previousVersion) {
    return ["app release version must change when bundled Agent version changes"];
  }
  return [];
}
