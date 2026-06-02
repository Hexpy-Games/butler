#!/usr/bin/env bun
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { cognitionMemoryRoot } from "../../agent/cognition/paths.ts";
import { buildImportPlan } from "../../agent/cognition/memory/scripts/import-session.ts";
import { readMemoryHealth } from "../../agent/cognition/memory/quality.ts";
import { AutomationStore, type AutomationPreview } from "../../operations/service/automation-store.ts";
import { butlerAgentSourcePath } from "../../runtime/paths.ts";
import { transcriptPath } from "../../test-support/harness/transcripts.ts";
import { parseCommonOptions, type ParsedCommonOptions } from "./args.ts";
import { renderJsonEnvelope } from "./output.ts";
import { loadPrivateEnvIntoProcess } from "./private-env.ts";

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function optionValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function commandString(args: string[]): string {
  return `butler ${args.join(" ")}`.trim();
}

function fail(
  parsed: ParsedCommonOptions,
  code: string,
  message: string,
  exitCode = 2,
): never {
  if (parsed.options.json) {
    process.stdout.write(renderJsonEnvelope({
      ok: false,
      command: commandString(parsed.args),
      error: { code, message },
    }));
  } else {
    console.error(message);
  }
  process.exit(exitCode);
}

function print(
  parsed: ParsedCommonOptions,
  command: string,
  data: unknown,
  human: string,
): void {
  if (parsed.options.json) {
    process.stdout.write(renderJsonEnvelope({
      ok: true,
      command,
      data,
    }));
  } else if (!parsed.options.quiet) {
    process.stdout.write(`${human.trimEnd()}\n`);
  }
}

function requireYes(parsed: ParsedCommonOptions, message: string): void {
  if (parsed.options.yes || parsed.options.nonInteractive) return;
  fail(parsed, "invalid_arguments", `${message} requires --yes`, 2);
}

function prepareEnvironment(parsed: ParsedCommonOptions): void {
  process.env.BUTLER_HOME = parsed.options.home;
  process.env.BUTLER_DATA = parsed.options.data;
  loadPrivateEnvIntoProcess(parsed.options.data);
}

function safeAutomationPreview(preview: AutomationPreview) {
  return {
    id: preview.id,
    title: preview.title,
    session_id: preview.session_id,
    status: preview.status,
    schedule: preview.schedule,
    next_run_at: preview.next_run_at,
    last_run_at: preview.last_run_at,
    run_count: preview.run_count,
    prompt_preview: preview.prompt_preview,
  };
}

function safeAutomationRun(run: ReturnType<AutomationStore["runNow"]>) {
  return {
    automation: safeAutomationPreview(run.automation),
    envelope: {
      eventId: run.envelope.eventId,
      transport: run.envelope.transport,
      accountId: run.envelope.accountId,
      peer: run.envelope.peer,
      routingHints: run.envelope.routingHints,
      messageTextIncluded: false,
    },
  };
}

function memoryIngest(parsed: ParsedCommonOptions, args: string[], commandBase: string): void {
  const sessionId = optionValue(args, "--session");
  if (!sessionId) fail(parsed, "invalid_arguments", "memory ingest requires --session SESSION_ID");
  const path = transcriptPath(sessionId);
  if (!existsSync(path)) fail(parsed, "not_found", `transcript not found for session: ${sessionId}`, 1);
  const plan = buildImportPlan(path);
  const dryRun = hasFlag(args, "--dry-run");
  const data = {
    dryRun,
    sessionId: plan.sessionId,
    project: plan.project,
    format: plan.format,
    transcriptPath: path,
    messages: plan.messages.length,
    chunks: plan.chunks.length,
    rawTextIncluded: false,
  };
  if (dryRun) {
    print(parsed, `${commandBase} ingest`, data, `Memory ingest dry-run: session=${plan.sessionId} messages=${plan.messages.length} chunks=${plan.chunks.length}`);
    return;
  }

  const result = spawnSync(process.execPath, [
    "run",
    butlerAgentSourcePath(parsed.options.home, "agent", "cognition", "memory", "scripts", "import-session.ts"),
    path,
  ], {
    cwd: parsed.options.home,
    encoding: "utf8",
    env: process.env,
  });
  if ((result.status ?? 1) !== 0) {
    fail(parsed, "external_unavailable", "memory ingestion command failed", 5);
  }
  print(parsed, `${commandBase} ingest`, {
    ...data,
    applied: true,
  }, `Memory ingest applied: session=${plan.sessionId} chunks=${plan.chunks.length}`);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function markdownMemoryBlocks(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s+\S/u.test(line) && current.some((entry) => entry.trim())) {
      blocks.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.some((entry) => entry.trim())) blocks.push(current.join("\n").trim());
  return blocks.filter((block) => block.trim());
}

function listMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const output: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      output.push(...listMarkdownFiles(path));
      continue;
    }
    if (entry.endsWith(".md")) output.push(path);
  }
  return output;
}

function backfillHotCacheVectorIndex(parsed: ParsedCommonOptions): {
  attempted: number;
  indexed: number;
  failed: number;
  rawTextIncluded: false;
} {
  const memoryRoot = cognitionMemoryRoot(parsed.options.data);
  const hotDir = join(memoryRoot, "hot");
  const indexScript = butlerAgentSourcePath(parsed.options.home, "agent", "cognition", "memory", "scripts", "index.ts");
  const tmpDir = join(memoryRoot, "queue", "hot-maintain-index");
  let attempted = 0;
  let indexed = 0;
  let failed = 0;

  for (const path of listMarkdownFiles(hotDir)) {
    const blocks = markdownMemoryBlocks(readFileSync(path, "utf8"));
    for (const [blockIndex, block] of blocks.entries()) {
      attempted += 1;
      const sessionId = `hot_maintain_${hashText(`${path}:${blockIndex}:${block}`)}`;
      const tmp = join(tmpDir, `${sessionId}.md`);
      mkdirSync(dirname(tmp), { recursive: true });
      writeFileSync(tmp, block, "utf8");
      try {
        const result = spawnSync(process.execPath, [
          "run",
          indexScript,
          "--file",
          tmp,
          "--project",
          "butler",
          "--session-id",
          sessionId,
          "--source-session-id",
          sessionId,
          "--type",
          "hot-cache",
          "--source",
          "hot-cache",
          "--plain-text",
        ], {
          cwd: parsed.options.home,
          encoding: "utf8",
          env: process.env,
        });
        if ((result.status ?? 1) === 0 && /Indexed \d+ chunks into LanceDB/.test(result.stdout)) {
          indexed += 1;
        } else {
          failed += 1;
        }
      } finally {
        try {
          unlinkSync(tmp);
        } catch {}
      }
    }
  }

  return {
    attempted,
    indexed,
    failed,
    rawTextIncluded: false,
  };
}

function memoryMaintain(parsed: ParsedCommonOptions, args: string[], commandBase: string): void {
  const before = readMemoryHealth({ butlerData: parsed.options.data });
  const hotCacheVectorBackfill = backfillHotCacheVectorIndex(parsed);
  const backfillOnly = hasFlag(args, "--hot-cache-backfill-only");
  const result = backfillOnly
    ? { status: 0, stdout: "hot-cache backfill only" }
    : spawnSync(process.execPath, [
      "run",
      butlerAgentSourcePath(parsed.options.home, "agent", "cognition", "memory", "scripts", "consolidation-cycle.ts"),
    ], {
      cwd: parsed.options.home,
      encoding: "utf8",
      env: process.env,
    });
  const after = readMemoryHealth({ butlerData: parsed.options.data });
  const data = {
    exitCode: result.status ?? 1,
    skipped: backfillOnly || result.stdout.includes("consolidation-cycle disabled"),
    before: {
      maintenanceStatus: before.maintenanceStatus,
      queueBacklog: before.queueBacklog,
      graphEntityCount: before.graphEntityCount,
      graphEdgeCount: before.graphEdgeCount,
    },
    after: {
      maintenanceStatus: after.maintenanceStatus,
      queueBacklog: after.queueBacklog,
      graphEntityCount: after.graphEntityCount,
      graphEdgeCount: after.graphEdgeCount,
    },
    hotCacheVectorBackfill,
    rawTextIncluded: false,
  };
  if ((result.status ?? 1) !== 0) {
    fail(parsed, "external_unavailable", "memory maintenance command failed", 5);
  }
  print(parsed, `${commandBase} maintain`, data, `Memory maintenance complete: status=${data.after.maintenanceStatus}`);
}

function memory(parsed: ParsedCommonOptions, args: string[], commandBase: string): void {
  if (args[0] === "ingest") return memoryIngest(parsed, args, commandBase);
  if (args[0] === "maintain") return memoryMaintain(parsed, args, commandBase);
  fail(parsed, "unknown_command", `unknown memory command: ${args[0] ?? ""}`);
}

function cognition(parsed: ParsedCommonOptions, args: string[], commandBase: "butler cognition" | "butler cog"): void {
  const [subcommand, ...rest] = args;
  if (subcommand === "memory") return memory(parsed, rest, `${commandBase} memory`);
  fail(parsed, "unknown_command", `unknown cognition command: ${subcommand ?? ""}`);
}

function removedLegacyMemory(parsed: ParsedCommonOptions): never {
  fail(parsed, "unknown_command", `unknown Butler command: ${parsed.args.join(" ")}`, 2);
}

function automation(parsed: ParsedCommonOptions, args: string[]): void {
  const subcommand = args[0];
  const store = new AutomationStore(parsed.options.data);
  if (subcommand === "list") {
    const status = optionValue(args, "--status");
    const automations = store.list({
      includeDeleted: hasFlag(args, "--include-deleted"),
    })
      .filter((item) => !status || item.status === status)
      .map(safeAutomationPreview);
    print(parsed, "butler automation list", { automations }, automations.length
      ? automations.map((item) => `${item.id}: ${item.status} next=${item.next_run_at ?? "none"}`).join("\n")
      : "No automations found.");
    return;
  }
  if (subcommand === "show") {
    const id = args[1];
    if (!id) fail(parsed, "invalid_arguments", "automation show requires <id>");
    const record = store.read(id);
    if (!record || record.status === "deleted") fail(parsed, "not_found", `automation not found: ${id}`, 1);
    print(parsed, "butler automation show", {
      automation: safeAutomationPreview(store.list({ includeDeleted: true }).find((item) => item.id === id)!),
    }, `${record.id}: ${record.status} next=${record.next_run_at ?? "none"}`);
    return;
  }
  if (subcommand === "run") {
    const id = args[1];
    if (!id) fail(parsed, "invalid_arguments", "automation run requires <id>");
    try {
      const run = store.runNow(id);
      const data = safeAutomationRun(run);
      print(parsed, "butler automation run", data, `Automation run claimed: ${data.automation.id}`);
    } catch (error) {
      fail(parsed, "invalid_state", error instanceof Error ? error.message : String(error), 1);
    }
    return;
  }
  if (subcommand === "delete") {
    requireYes(parsed, "automation delete");
    const id = args[1];
    if (!id) fail(parsed, "invalid_arguments", "automation delete requires <id>");
    try {
      const deleted = store.delete(id);
      print(parsed, "butler automation delete", {
        automation: safeAutomationPreview(deleted),
      }, `Automation deleted: ${deleted.id}`);
    } catch (error) {
      fail(parsed, "not_found", error instanceof Error ? error.message : String(error), 1);
    }
    return;
  }
  fail(parsed, "unknown_command", `unknown automation command: ${subcommand ?? ""}`);
}

async function main(): Promise<void> {
  const parsed = parseCommonOptions(Bun.argv.slice(2));
  if (parsed.errors.length > 0) fail(parsed, "invalid_arguments", parsed.errors.join("; "));
  prepareEnvironment(parsed);
  const [command, ...args] = parsed.args;
  if (command === "cognition") return cognition(parsed, args, "butler cognition");
  if (command === "cog") return cognition(parsed, args, "butler cog");
  if (command === "memory") return removedLegacyMemory(parsed);
  if (command === "automation") return automation(parsed, args);
  fail(parsed, "unknown_command", `unknown Butler advanced command: ${parsed.args.join(" ")}`);
}

if (import.meta.main) {
  await main();
}
