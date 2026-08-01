import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAYOUT_DIRS } from "./constants.js";
import { CliError, nowIso } from "./errors.js";
import { projectRoot, requiredOption } from "./args.js";
import {
  appendLedgerEvent,
  ensureDir,
  ledgerRoot,
  projectRelative,
  safeReadJson,
  safeWriteJson,
} from "./fs.js";
import {
  assertSupportedQueryKind,
  check,
  doctor,
  loadIndex,
  projectStatus,
  queryIndex,
  writeIndex,
} from "./indexer.js";
import { handleNestedCommand } from "./lifecycle-commands.js";
import { render } from "./renderer.js";
import { installSkill } from "./distribution.js";
import { migrateDocs } from "./docs-migration.js";
import { withProjectLedgerMutation } from "./mutation-lock.js";

export function initProject(options) {
  return withProjectLedgerMutation(projectRoot(options), () => initProjectLocked(options));
}

function initProjectLocked(options) {
  const project = projectRoot(options);
  const id = requiredOption(options, "id");
  const name = requiredOption(options, "name");

  ensureDir(ledgerRoot(project));
  for (const dir of LAYOUT_DIRS) ensureDir(join(ledgerRoot(project), dir));

  const projectFile = join(ledgerRoot(project), "project.json");
  const timestamp = nowIso();
  if (!existsSync(projectFile)) {
    safeWriteJson(projectFile, {
      schema: "project-ledger.project.v1",
      id,
      name,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  const ledgerFile = join(ledgerRoot(project), "ledger.jsonl");
  if (!existsSync(ledgerFile)) writeFileSync(ledgerFile, "", "utf8");
  appendLedgerEvent(project, {
    type: "project_initialized",
    projectId: id,
    source: "project-ledger",
  });

  const rootLabel = projectRelative(project, ledgerRoot(project));
  return {
    project: safeReadJson(projectFile),
    root: rootLabel,
    directories: LAYOUT_DIRS.map((dir) => `${rootLabel}/${dir}`),
  };
}

export function help(short = false) {
  if (short) {
    return [
      "Project Ledger CLI",
      "",
      "Common workflow:",
      "  pl status --project PATH [--json]                         = project-ledger status",
      "  pl list <kind> --project PATH [--status STATE] [--json]   = project-ledger query --kind <kind>",
      "  pl show ID [--kind KIND] [--body] [--json]                = project-ledger record show",
      "  pl create KIND ID --title TITLE [--parent ID] ... [--json] = create record/work/task/attempt",
      "  pl edit ID [--kind KIND] [--title TITLE] [--from FILE|-]  = project-ledger record update",
      "  pl start ID [--kind work|task|attempt] [--json]           = start work/task or keep attempt started",
      "  pl review ID [--kind work] [--json]                       = record update --status review",
      "  pl complete ID [--kind work|task|attempt] ... [--json]    = lifecycle complete/succeed",
      "  pl block ID [--kind work|task] --reason TEXT [--json]     = lifecycle update --status blocked",
      "  pl cancel ID [--kind work|task] --reason TEXT [--json]    = lifecycle update --status cancelled",
      "  pl index --project PATH [--json]                          = project-ledger index",
      "  pl render dashboard|handoff|roadmap --project PATH [--write]",
      "  pl check --project PATH [--verbose] [--json]",
      "",
      "Use project-ledger help for the full command reference.",
    ].join("\n");
  }
  return [
    "Project Ledger CLI",
    "",
    "Commands:",
    "  project-ledger init --project PATH --id ID --name NAME [--json]",
    "  project-ledger index --project PATH [--json]",
    "  project-ledger status --project PATH [--json]",
    "  project-ledger query --project PATH --kind KIND [--json]",
    "  project-ledger render --project PATH dashboard|handoff|roadmap [--write] [--json]",
    "  project-ledger doctor --project PATH [--json] [--fail-on-error] [--silent] [--verbose]",
    "  project-ledger check --project PATH [--json] [--silent] [--verbose]",
    "  project-ledger record create|show|update --project PATH --kind KIND --id ID [--from FILE|-] ...",
    "  project-ledger work create|update|complete --project PATH --id ID ...",
    "  project-ledger spec show|update --project PATH --id ID [--from FILE|-] ...",
    "  project-ledger plan create|show|update --project PATH --id ID [--from FILE|-] ...",
    "  project-ledger task create|update|complete --project PATH --id ID ...",
    "  project-ledger attempt start|succeed|fail --project PATH --id ID ...",
    "  project-ledger install-skill --target PATH [--mode symlink|copy]",
    "  project-ledger migrate-docs --project PATH [--write] [--json]",
    "",
    "Output Flags:",
    "  --silent   Suppress output on success (human mode only)",
    "  --verbose  Show detailed output (human mode only)",
    "  --json     Output structured JSON envelope (preserves full data)",
  ].join("\n");
}

export function handle(command, positionals, options) {
  const project = projectRoot(options);
  if (command === "init") return initProject(options);
  if (command === "index") return writeIndex(project);
  if (command === "status") return projectStatus(project);
  if (command === "query") {
    const kind = requiredOption(options, "kind");
    assertSupportedQueryKind(kind);
    return { kind, results: queryIndex(loadIndex(project), kind, options) };
  }
  if (command === "render") {
    const viewName = positionals[0];
    if (!viewName) throw new CliError("render requires dashboard, handoff, or roadmap");
    return render(project, viewName, options);
  }
  if (command === "doctor") return doctor(project);
  if (command === "check") return check(project);
  if (command === "install-skill") return installSkill(options);
  if (command === "migrate-docs") return migrateDocs(project, options);
  if (
    command === "record" ||
    command === "work" ||
    command === "spec" ||
    command === "plan" ||
    command === "task" ||
    command === "attempt"
  ) {
    return handleNestedCommand(command, positionals[0], project, options);
  }
  if (!command || command === "help") return help(options.short);
  throw new CliError(`Unknown command: ${command}`, "unknown_command", 2);
}

export function commandShouldFail(command, options, data) {
  if (command === "check") return data?.ok === false;
  if (command === "doctor" && options["fail-on-error"]) return data?.ok === false;
  if (command === "doctor" && options["fail-on-warning"]) return data?.issues?.length > 0;
  return false;
}
