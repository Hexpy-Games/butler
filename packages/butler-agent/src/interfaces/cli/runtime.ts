import { existsSync } from "fs";
import { join } from "path";

export interface ResolveBunPathInput {
  butlerData: string;
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
}

export function managedBunPath(butlerData: string): string {
  return join(butlerData, "runtime", "bun", "current", "bin", "bun");
}

export function resolveBunPath(input: ResolveBunPathInput): string {
  const env = input.env ?? process.env;
  const exists = input.exists ?? existsSync;

  if (env.BUTLER_BUN) return env.BUTLER_BUN;

  const managed = managedBunPath(input.butlerData);
  if (exists(managed)) return managed;

  return "bun";
}
