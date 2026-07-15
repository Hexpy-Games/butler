import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";

import { parseCommonOptions } from "../../packages/butler-agent/src/interfaces/cli/args.ts";
import { findCommand, listCommands } from "../../packages/butler-agent/src/interfaces/cli/command-registry.ts";
import { createJsonEnvelope } from "../../packages/butler-agent/src/interfaces/cli/output.ts";
import { resolveBunPath } from "../../packages/butler-agent/src/interfaces/cli/runtime.ts";

function tempRoot(): string {
  const dir = join(tmpdir(), `butler-cli-registry-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("typed command registry exposes priority classes without maintainer commands", () => {
  const commands = listCommands();
  const usages = commands.map((command) => command.usage);
  const ids = commands.map((command) => command.id);

  expect(new Set(commands.map((command) => command.priority))).toEqual(
    new Set(["core", "operator", "advanced", "deferred"]),
  );
  expect(new Set(ids).size).toBe(ids.length);
  expect(usages).toContain("butler commands [--json]");
  expect(usages).toContain("butler maintenance context [--json]");
  expect(usages).not.toContain("butler check");
  expect(usages).not.toContain("butler release gate");
});

test("typed command registry resolves exact command paths", () => {
  expect(findCommand(["metrics", "status"])?.usage).toBe(
    "butler metrics status [--json] [--since-hours N]",
  );
  expect(findCommand(["maintenance", "context"])?.usage).toBe(
    "butler maintenance context [--json]",
  );
  expect(findCommand(["gateway", "status"])?.usage).toBe(
    "butler gateway status [<gateway>] [--json]",
  );
  expect(findCommand(["gateway", "run", "app"])?.usage).toBe(
    "butler gateway run app",
  );
  expect(findCommand(["release", "gate"])).toBeNull();
});

test("common option parser normalizes product-wide options", () => {
  const parsed = parseCommonOptions([
    "status",
    "--json",
    "--home",
    "~/custom-butler",
    "--data",
    "~/custom-data",
    "--verbose",
    "--quiet",
    "--yes",
    "--non-interactive",
  ]);

  expect(parsed.args).toEqual(["status"]);
  expect(parsed.options.json).toBe(true);
  expect(parsed.options.verbose).toBe(true);
  expect(parsed.options.quiet).toBe(true);
  expect(parsed.options.yes).toBe(true);
  expect(parsed.options.nonInteractive).toBe(true);
  expect(basename(parsed.options.home)).toBe("custom-butler");
  expect(basename(parsed.options.data)).toBe("custom-data");
  expect(parsed.errors).toEqual([]);
});

test("common option parser reports missing option values", () => {
  const parsed = parseCommonOptions(["status", "--data", "--json", "--home"]);

  expect(parsed.args).toEqual(["status"]);
  expect(parsed.options.json).toBe(true);
  expect(parsed.errors).toEqual(["--data requires a path", "--home requires a path"]);
});

test("common option parser treats --silent as alias for --quiet", () => {
  const parsedWithQuiet = parseCommonOptions(["status", "--quiet"]);
  const parsedWithSilent = parseCommonOptions(["status", "--silent"]);

  expect(parsedWithQuiet.options.quiet).toBe(true);
  expect(parsedWithSilent.options.quiet).toBe(true);
  expect(parsedWithQuiet.args).toEqual(["status"]);
  expect(parsedWithSilent.args).toEqual(["status"]);
});

test("JSON envelope uses privacy-safe defaults for success and failure", () => {
  expect(createJsonEnvelope({
    ok: true,
    command: "butler commands",
    data: { commands: [] },
  })).toEqual({
    ok: true,
    command: "butler commands",
    data: { commands: [] },
    error: null,
    privacy: {
      rawTextIncluded: false,
      secretsIncluded: false,
    },
  });

  expect(createJsonEnvelope({
    ok: false,
    command: "butler missing",
    error: {
      code: "unknown_command",
      message: "unknown command",
    },
  })).toEqual({
    ok: false,
    command: "butler missing",
    data: null,
    error: {
      code: "unknown_command",
      message: "unknown command",
    },
    privacy: {
      rawTextIncluded: false,
      secretsIncluded: false,
    },
  });
});

test("managed Bun resolver prefers override then managed runtime then system fallback", () => {
  const butlerData = tempRoot();
  const override = join(butlerData, "override-bun");
  const managedBinDir = join(butlerData, "runtime", "bun", "current", "bin");
  const managedBun = join(managedBinDir, "bun");

  try {
    mkdirSync(managedBinDir, { recursive: true });
    writeFileSync(override, "");
    writeFileSync(managedBun, "");

    expect(resolveBunPath({
      butlerData,
      env: { BUTLER_BUN: override },
    })).toBe(override);

    expect(resolveBunPath({
      butlerData,
      env: {},
    })).toBe(managedBun);

    rmSync(join(butlerData, "runtime"), { recursive: true, force: true });
    expect(resolveBunPath({
      butlerData,
      env: {},
    })).toBe("bun");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
