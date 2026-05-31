import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  indexTranscriptLinesForQuery,
  transcriptQueryDbPath,
} from "../exact-query.ts";

interface FileSummary {
  path: string;
  lines: number;
  indexed: number;
}

const BATCH_SIZE = 10_000;

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function usage(): never {
  console.error([
    "Usage: bun run packages/butler-agent/src/agent/cognition/memory/scripts/build-query-index.ts [--data <BUTLER_DATA>] [--transcripts <dir>] [--file <jsonl>] [--verbose]",
    "",
    "Builds the SQLite query_memory projection from durable transcript JSONL.",
    "The runtime query_memory tool reads only the projection, never the source JSONL.",
  ].join("\n"));
  process.exit(2);
}

async function indexFile(input: {
  butlerData: string;
  path: string;
}): Promise<FileSummary> {
  let lines = 0;
  let indexed = 0;
  let batch: string[] = [];

  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    const result = indexTranscriptLinesForQuery({
      butlerData: input.butlerData,
      transcriptFile: input.path,
      lines: batch,
    });
    indexed += result.indexed;
    batch = [];
  }

  const reader = createInterface({
    input: createReadStream(input.path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    if (!line.trim()) continue;
    lines += 1;
    batch.push(line);
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();
  return { path: input.path, lines, indexed };
}

function transcriptFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .sort();
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage();
  const butlerData = resolve(
    optionValue("--data") ??
      process.env.BUTLER_DATA ??
      join(homedir(), ".butler"),
  );
  const explicitFile = optionValue("--file");
  const verbose = process.argv.includes("--verbose");
  const transcriptsDir = resolve(
    optionValue("--transcripts") ??
      join(butlerData, "transcripts"),
  );
  const files = explicitFile
    ? [resolve(explicitFile)]
    : transcriptFiles(transcriptsDir);

  const summaries: FileSummary[] = [];
  for (const path of files) {
    summaries.push(await indexFile({ butlerData, path }));
  }

  const totalLines = summaries.reduce((sum, item) => sum + item.lines, 0);
  const totalIndexed = summaries.reduce((sum, item) => sum + item.indexed, 0);
  console.log(JSON.stringify({
    ok: true,
    butlerData,
    transcriptsDir,
    queryDbPath: transcriptQueryDbPath(butlerData),
    files: summaries.length,
    lines: totalLines,
    indexed: totalIndexed,
    ...(verbose ? { summaries } : {}),
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
