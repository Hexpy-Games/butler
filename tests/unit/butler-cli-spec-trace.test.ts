import { expect, test } from "bun:test";
import { readRepoOrLedgerFile, repoOrLedgerExists } from "../support/project-ledger-root.ts";

const childSpecs = [
  ".project-ledger/specs/cli/core-commands.md",
  ".project-ledger/specs/cli/operator-commands.md",
  ".project-ledger/specs/cli/advanced-deferred-commands.md",
];
const legacyChildSpecs = [
  "docs/specs/cli/core-commands.md",
  "docs/specs/cli/operator-commands.md",
  "docs/specs/cli/advanced-deferred-commands.md",
];

const expectedCommands = [
  "butler help",
  "butler help <command>",
  "butler commands [--json]",
  "butler version [--json]",
  "butler install [--home PATH] [--data PATH] [--non-interactive] [--register-service|--no-register-service]",
  "butler upgrade-report [--home PATH] [--data PATH]",
  "butler start",
  "butler stop",
  "butler restart",
  "butler service run",
  "butler service launchd-plist [--json]",
  "butler service systemd-unit [--json]",
  "butler service install [--platform auto|launchd|systemd] [--dry-run] [--yes] [--json]",
  "butler service status [--platform auto|launchd|systemd] [--json]",
  "butler service uninstall [--platform auto|launchd|systemd] [--dry-run] [--yes] [--json]",
  "butler gateway app",
  "butler gateway list [--json]",
  "butler gateway status [<gateway>] [--json]",
  "butler gateway inspect <gateway> [--json]",
  "butler gateway enable <gateway> [--json]",
  "butler gateway disable <gateway> [--json]",
  "butler gateway configure app --host HOST --port PORT [--db PATH] [--json]",
  "butler gateway configure telegram [--chat-id ID] [--format markdownv2|plain] [--json]",
  "butler gateway credential set telegram --token-stdin [--json]",
  "butler gateway pair telegram [--json]",
  "butler gateway unpair telegram [--yes] [--json]",
  "butler gateway test <gateway> [--json]",
  "butler gateway logs <gateway> [--lines N] [--follow]",
  "butler gateway run app",
  "butler gateway start <gateway> [--json]",
  "butler gateway stop <gateway> [--json]",
  "butler gateway restart <gateway> [--yes] [--json]",
  "butler status [--json] [--verbose]",
  "butler doctor [--fix] [--json] [--check NAME]",
  "butler metrics status [--json] [--since-hours N]",
  "butler metrics enable",
  "butler metrics disable",
  "butler auth status [--json]",
  "butler auth login",
  "butler model status [--json]",
  "butler runtime repair [--yes]",
  "butler telegram pair",
  "butler telegram status [--json]",
  "butler update [--component service|app] [--check|--apply] [--manifest PATH] [--dry-run] [--yes]",
  "butler uninstall [--keep-data] [--yes]",
  "butler logs [--service NAME] [--lines N] [--follow]",
  "butler ps [--json]",
  "butler metrics tail [--lines N] [--json]",
  "butler config get <path> [--json]",
  "butler config set <path> <value> [--json]",
  "butler config edit",
  "butler config validate [--json]",
  "butler personalization show [--json]",
  "butler personalization set [--butler-nickname NAME] [--principal-name NAME] [--preferred-address NAME] [--profiling-mode off|basic|deep] [--clear-profile] [--json]",
  "butler auth logout [--yes]",
  "butler model list [--json]",
  "butler model set <provider/model>",
  "butler transport status [--json]",
  "butler transport test [--transport NAME]",
  "butler telegram send-test [--message TEXT]",
  "butler telegram unpair [--yes]",
  "butler work dashboard [--json] [--debug]",
  "butler work list [--json] [--status STATUS]",
  "butler work show <id> [--json]",
  "butler work resume <id|latest>",
  "butler work cancel <id> [--yes]",
  "butler work retry <id>",
  "butler cognition memory status [--json]",
  "butler cognition memory recall <cue> [--json]",
  "butler cognition memory project inspect <project-id> [--json]",
  "butler context status [--json]",
  "butler context compact [--session SESSION_ID] [--yes]",
  "butler context prune [--json]",
  "butler maintenance context [--json]",
  "butler search status [--json]",
  "butler search test <query> [--json]",
  "butler web read <url> [--json]",
  "butler cognition memory ingest [--session SESSION_ID] [--dry-run]",
  "butler cognition memory maintain [--hot-cache-backfill-only] [--json]",
  "butler cognition migrate --status|--dry-run|--apply [--json]",
  "butler automation list [--json]",
  "butler automation show <id> [--json]",
  "butler automation run <id>",
  "butler automation delete <id> [--yes]",
  "butler todo list [--json]",
  "butler todo add <text>",
  "butler todo update <id> --status STATUS",
  "butler automation pause <id>",
  "butler automation resume <id>",
];

test("Butler CLI parent spec links command-level child specs", () => {
  const parent = readRepoOrLedgerFile(".project-ledger/specs/butler-cli.md");

  expect(parent).toContain("No command may be implemented");
  expect(parent).toContain("Maintainer Boundary");
  expect(parent).toContain("Minimum Command Test Contract");
  expect(parent).toContain("JSON Examples");
  for (const [index, childSpec] of childSpecs.entries()) {
    expect(repoOrLedgerExists(childSpec)).toBe(true);
    expect(parent).toContain(legacyChildSpecs[index]);
  }
});

test("every Butler CLI command has a command-level sub-spec", () => {
  const childSpecText = childSpecs.map(readRepoOrLedgerFile).join("\n");

  for (const command of expectedCommands) {
    expect(childSpecText).toContain(`### \`${command}\``);
  }
});

test("command-level specs include necessity privacy and tests", () => {
  for (const childSpec of childSpecs) {
    const text = readRepoOrLedgerFile(childSpec);
    expect(text).toContain("Parent spec: `docs/specs/butler-cli.md`");
    expect(text).toMatch(/Necessity|necessity|Reason deferred|Promotion condition/);
    expect(text).toMatch(/Privacy|privacy/);
    expect(text).toMatch(/Tests|tests/);
  }
});

test("completed CLI parent spec has consistent child spec statuses", () => {
  const parent = readRepoOrLedgerFile(".project-ledger/specs/butler-cli.md");
  expect(parent).toContain("Status: Complete.");

  expect(readRepoOrLedgerFile(".project-ledger/specs/cli/core-commands.md")).toContain("Status: Implemented.");
  expect(readRepoOrLedgerFile(".project-ledger/specs/cli/operator-commands.md")).toContain("Status: Implemented.");
  expect(readRepoOrLedgerFile(".project-ledger/specs/cli/advanced-deferred-commands.md")).toContain(
    "Status: Advanced implemented; Deferred commands remain unimplemented.",
  );
});
