import { spawnSync } from "node:child_process";

export interface WindowsValidationToken {
  accepted: boolean;
  standardUser: boolean;
  ciElevatedToken: boolean;
}

export function windowsValidationToken(
  env: NodeJS.ProcessEnv = process.env,
): WindowsValidationToken {
  const result = spawnSync("whoami.exe", ["/groups", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const groups = result.status === 0 ? String(result.stdout) : "";
  const mediumIntegrity = groups.includes("S-1-16-8192") &&
    !groups.includes("S-1-16-12288");
  const highIntegrity = groups.includes("S-1-16-12288");
  const ciElevatedToken =
    !mediumIntegrity &&
    highIntegrity &&
    env.CI === "true" &&
    env.BUTLER_WINDOWS_CI_ELEVATED_TOKEN === "1";
  return {
    accepted: mediumIntegrity || ciElevatedToken,
    standardUser: mediumIntegrity,
    ciElevatedToken,
  };
}
