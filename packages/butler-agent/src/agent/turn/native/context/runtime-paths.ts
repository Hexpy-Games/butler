import { homedir } from "os";
import { join } from "path";

export function getButlerHome(explicit?: string): string {
  return explicit || process.env.BUTLER_HOME || process.cwd();
}

export function getButlerData(explicit?: string): string {
  return explicit || process.env.BUTLER_DATA || join(homedir(), ".butler");
}
