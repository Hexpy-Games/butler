import { homedir } from "node:os";
import { join } from "node:path";
import {
  readHistoricalAppProjectionRows,
  readHistoricalTranscriptRows,
  runHistoricalConversationRecovery,
} from "./historical-recovery.ts";

const args = process.argv.slice(2);

function arg(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

function usage(code: 0 | 2): never {
  console.error([
    "Usage: bun run packages/butler-agent/src/agent/conversation/historical-recovery-cli.ts [--data PATH] [--transcript-file PATH] [--app-db PATH] [--write]",
    "",
    "Default mode is dry-run. Reports counts, ids, reasons, and canonical mappings without raw conversation text.",
  ].join("\n"));
  process.exit(code);
}

if (hasFlag("--help") || hasFlag("-h")) usage(0);

const butlerData = arg("--data") ?? process.env.BUTLER_DATA ?? join(homedir(), ".butler");
const transcriptFile = arg("--transcript-file");
const appDb = arg("--app-db");
if (!transcriptFile && !appDb) usage(2);

const report = runHistoricalConversationRecovery({
  butlerData,
  dryRun: !hasFlag("--write"),
  transcriptRows: transcriptFile ? readHistoricalTranscriptRows(transcriptFile) : [],
  appRows: appDb ? readHistoricalAppProjectionRows(appDb) : [],
});

console.log(JSON.stringify(report, null, 2));
