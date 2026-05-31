import { BUTLER_DIR } from "./constants.ts";
import { refreshProjectCapsule } from "../project-memory.ts";

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const projectId = getArg(args, "--project") ?? getArg(args, "--project-id");
  if (!projectId) {
    console.error("usage: refresh-project-capsule.ts --project <project-id> [--workspace-path <path>] [--max-bytes <n>]");
    process.exit(2);
  }

  const maxBytesRaw = getArg(args, "--max-bytes");
  const maxBytes = maxBytesRaw ? Number.parseInt(maxBytesRaw, 10) : undefined;
  const result = refreshProjectCapsule({
    butlerData: getArg(args, "--butler-data") ?? BUTLER_DIR.DATA,
    projectId,
    workspacePath: getArg(args, "--workspace-path"),
    maxBytes: Number.isFinite(maxBytes) ? maxBytes : undefined,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
