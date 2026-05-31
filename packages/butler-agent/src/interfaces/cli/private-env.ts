import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export function privateEnvPath(butlerData: string): string {
  return join(butlerData, ".env");
}

export function readPrivateEnv(butlerData: string): Record<string, string> {
  const envPath = privateEnvPath(butlerData);
  if (!existsSync(envPath)) return {};

  const env: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function loadPrivateEnvIntoProcess(butlerData: string): Record<string, string> {
  const env = readPrivateEnv(butlerData);
  for (const [key, value] of Object.entries(env)) {
    if (!process.env[key]) process.env[key] = value;
  }
  return env;
}

export function upsertPrivateEnvValue(butlerData: string, key: string, value: string): void {
  const envPath = privateEnvPath(butlerData);
  mkdirSync(dirname(envPath), { recursive: true, mode: 0o700 });
  const lines = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/) : [];
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${JSON.stringify(value)}`;
    }
    return line;
  }).filter((line, index, array) => line || index < array.length - 1);
  if (!found) next.push(`${key}=${JSON.stringify(value)}`);
  writeFileSync(envPath, `${next.join("\n")}\n`, { mode: 0o600 });
}

export function deletePrivateEnvValue(butlerData: string, key: string): boolean {
  const envPath = privateEnvPath(butlerData);
  if (!existsSync(envPath)) return false;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  let removed = false;
  const next = lines.filter((line) => {
    if (line.startsWith(`${key}=`)) {
      removed = true;
      return false;
    }
    return true;
  }).filter((line, index, array) => line || index < array.length - 1);
  writeFileSync(envPath, `${next.join("\n")}\n`, { mode: 0o600 });
  return removed;
}
