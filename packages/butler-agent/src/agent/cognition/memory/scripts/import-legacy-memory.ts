import { homedir } from "os";
import { join } from "path";
import { importLegacyMemory } from "../legacy-import.ts";

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const args = process.argv.slice(2);
const legacyMemoryRoot = getArg(args, "--input") ?? join(homedir(), ".butler.back", "data", "memory");
const butlerData = process.env.BUTLER_DATA ?? join(homedir(), ".butler");
const dryRun = !args.includes("--apply");

const result = importLegacyMemory({
  legacyMemoryRoot,
  butlerData,
  dryRun,
});

console.log(JSON.stringify(result, null, 2));
