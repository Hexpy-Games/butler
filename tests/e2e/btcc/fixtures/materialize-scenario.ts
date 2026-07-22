import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type {
  LiveScenario,
  ScenarioFixture,
} from "../contracts.ts";
import type { LoadedFixtureCatalog } from "./fixture-catalog.ts";

export function materializeScenario(input: {
  scenario: LiveScenario;
  scenarioRoot: string;
  catalog: LoadedFixtureCatalog;
}): ScenarioFixture {
  const workspacePath = join(input.scenarioRoot, "workspace");
  const butlerData = join(input.scenarioRoot, "butler-data");
  const projectRef = input.scenario.turns.some((turn) => turn.expectedLedgerScope === "project")
    ? projectId(input.scenario.scenarioId)
    : undefined;
  const sessionId = `btcc-live/${input.scenario.scenarioId.toLowerCase()}`;
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(butlerData, { recursive: true });

  const context: ScenarioFixture["context"] = {
    profile: [],
    recentFeedback: [],
    mandatoryHotCache: [],
    optionalHotCache: [],
  };
  const canonicalMessages = new Map<string, string>();
  const sourceRefs: string[] = [];
  const hasRepositorySeed = input.scenario.setupSteps.some((step) => step.kind === "seed_repository");
  for (const setup of input.scenario.setupSteps) {
    const ref = setupRef(setup);
    if (!ref) continue;
    sourceRefs.push(ref);
    const entry = requireEntry(input.catalog, ref);
    switch (setup.kind) {
      case "create_fixture_root":
        if (!hasRepositorySeed) copyDirectory(entry, workspacePath);
        break;
      case "seed_repository":
        copyDirectory(entry, workspacePath);
        break;
      case "seed_project_ledger":
        if (!projectRef) throw new Error("Project Ledger fixture has no project-scoped Turn");
        copyDirectory(entry, join(butlerData, "project-ledger", "projects", projectRef));
        break;
      case "seed_session_ledger":
        context.mandatoryHotCache.push(readContext(entry));
        break;
      case "seed_profile":
        context.profile.push(readText(entry));
        break;
      case "seed_recent_feedback":
        context.recentFeedback.push(readText(entry));
        break;
      case "seed_sentinel": {
        const target = join(workspacePath, ".btcc-fixtures", basename(entry.resolvedPath));
        mkdirSync(join(workspacePath, ".btcc-fixtures"), { recursive: true });
        cpSync(entry.resolvedPath, target, { force: false, errorOnExist: true });
        break;
      }
      case "bind_prior_conversation": {
        const content = readText(entry);
        context.mandatoryHotCache.push(content);
        for (const turn of input.scenario.turns) {
          if (turn.inbound.kind === "canonical_local_ref") {
            canonicalMessages.set(turn.inbound.messageRef, content);
          }
        }
        break;
      }
      default:
        throw new Error(`Unsupported live setup step: ${setup.kind}`);
    }
  }
  writeFileSync(join(input.scenarioRoot, "fixture-receipt.json"), `${JSON.stringify({
    schema: "butler.btcc.live-fixture-receipt.v1",
    scenarioId: input.scenario.scenarioId,
    fixtureCatalogSha256: input.catalog.sha256,
    sourceRefs: [...sourceRefs].sort(),
    workspacePath,
    butlerData,
  }, null, 2)}\n`);
  return {
    workspacePath,
    butlerData,
    ...(projectRef ? { projectRef } : {}),
    sessionId,
    sourceRefs,
    context,
    canonicalMessages,
  };
}

function setupRef(setup: LiveScenario["setupSteps"][number]): string | null {
  for (const [key, value] of Object.entries(setup)) {
    if (key.endsWith("Ref") && typeof value === "string" && !value.startsWith("fixture-head:")) {
      return value;
    }
  }
  return null;
}

function requireEntry(catalog: LoadedFixtureCatalog, ref: string) {
  const entry = catalog.entries.get(ref);
  if (!entry) throw new Error(`Missing fixture catalog entry: ${ref}`);
  return entry;
}

function copyDirectory(
  entry: ReturnType<typeof requireEntry>,
  target: string,
): void {
  if (entry.kind !== "directory") throw new Error(`Fixture must be a directory: ${entry.ref}`);
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(entry.resolvedPath)) {
    cpSync(join(entry.resolvedPath, name), join(target, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
}

function readText(entry: ReturnType<typeof requireEntry>): string {
  if (entry.kind !== "text") throw new Error(`Fixture must be UTF-8 text: ${entry.ref}`);
  return readFileSync(entry.resolvedPath, "utf8");
}

function readContext(entry: ReturnType<typeof requireEntry>): string {
  return entry.kind === "text"
    ? readText(entry)
    : readFileSync(join(entry.resolvedPath, "ledger.md"), "utf8");
}

function projectId(scenarioId: string): string {
  return `btcc-live-${scenarioId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}
