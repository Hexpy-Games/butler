import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import commandData from "../../packages/butler-agent/src/interfaces/cli/commands.json";
import { listCommands } from "../../packages/butler-agent/src/interfaces/cli/command-registry.ts";

const root = process.cwd();
const cli = join(root, "bin", "butler.js");

const deferredIds = [
  "todo.list",
  "todo.add",
  "todo.update",
  "automation.pause",
  "automation.resume",
] as const;

function tempRoot(): string {
  const dir = join(tmpdir(), `butler-cli-deferred-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runCli(args: string[], butlerData: string) {
  return Bun.spawnSync(["node", cli, ...args, "--data", butlerData], {
    cwd: root,
    env: {
      ...process.env,
      BUTLER_DATA: butlerData,
      BUTLER_HOME: root,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function stdoutText(result: ReturnType<typeof runCli>): string {
  return new TextDecoder().decode(result.stdout);
}

test("deferred command registry entries cannot be silently promoted", () => {
  const commands = commandData.filter((command) => deferredIds.includes(command.id as (typeof deferredIds)[number]));
  const allDeferred = commandData.filter((command) => command.priority === "deferred");

  expect(allDeferred).toHaveLength(deferredIds.length);
  expect(commands.map((command) => command.id).sort()).toEqual([...deferredIds].sort());
  for (const command of commands) {
    expect(command.priority).toBe("deferred");
    expect(command.status).toBe("deferred");
    expect(command.implemented).toBe(false);
    expect(command.spec).toBe("docs/specs/cli/advanced-deferred-commands.md");
  }

  const implementedIds = new Set(listCommands({ implementedOnly: true }).map((command) => command.id));
  for (const id of deferredIds) {
    expect(implementedIds.has(id)).toBe(false);
  }
});

test("deferred command invocations fail safely and do not mutate Butler data", () => {
  const invocations = [
    ["todo", "list", "--json"],
    ["todo", "add", "buy milk", "--json"],
    ["todo", "update", "todo-1", "--status", "done", "--json"],
    ["automation", "pause", "automation-1", "--json"],
    ["automation", "resume", "automation-1", "--json"],
  ];

  for (const args of invocations) {
    const butlerData = tempRoot();
    try {
      const result = runCli(args, butlerData);

      expect(result.exitCode).toBe(2);
      const parsed = JSON.parse(stdoutText(result));
      expect(parsed).toMatchObject({
        ok: false,
        error: {
          code: "feature_not_stable",
        },
        privacy: {
          rawTextIncluded: false,
          secretsIncluded: false,
        },
      });
      expect(readdirSync(butlerData)).toEqual([]);
    } finally {
      rmSync(butlerData, { recursive: true, force: true });
    }
  }
});

test("command inventory exposes deferred status without marking commands available", () => {
  const butlerData = tempRoot();
  try {
    const result = runCli(["commands", "--json"], butlerData);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutText(result));
    const commands = parsed.data.commands.filter((command: { id: string }) => deferredIds.includes(command.id as (typeof deferredIds)[number]));
    expect(commands).toHaveLength(deferredIds.length);
    for (const command of commands) {
      expect(command.priority).toBe("deferred");
      expect(command.status).toBe("deferred");
      expect(command.implemented).toBe(false);
    }
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("deferred command help and partial paths stay explicit", () => {
  const butlerData = tempRoot();
  try {
    const help = runCli(["help", "todo", "list"], butlerData);
    expect(help.exitCode).toBe(0);
    expect(stdoutText(help)).toContain("Status: deferred");
    expect(stdoutText(help)).toContain("docs/specs/cli/advanced-deferred-commands.md");

    const partial = runCli(["todo", "--json"], butlerData);
    expect(partial.exitCode).toBe(2);
    const parsed = JSON.parse(stdoutText(partial));
    expect(parsed.error.code).toBe("unknown_command");
    expect(readdirSync(butlerData)).toEqual([]);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
