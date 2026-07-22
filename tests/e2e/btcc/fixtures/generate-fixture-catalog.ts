import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FixtureCatalog,
  FixtureCatalogEntry,
  LiveScenario,
} from "../contracts.ts";
import { REPOSITORY_ROOT } from "../environment/live-run-environment.ts";
import { hashDirectory } from "./fixture-digest.ts";

const PRIOR_SANDY_MESSAGE =
  "이제 잘된다! 잘했어. 그런데 이제 음성이 Wav파일이라 그런지 그냥 첨부파일로 붙어버리네. 물론재생 컨트롤은 나오지만 파일이름 없이 재생컨트롤만 나오는 그런 음성메시지로 보낼 수 있는 방법은 없는지 알아봐줄래";

export function ensureRepoLocalFixtureCatalog(scenarios: LiveScenario[]): string {
  const fixtures = fixtureRequirements(scenarios);
  const identity = digest(`${JSON.stringify(fixtures)}\0${readFileSync(fileURLToPath(import.meta.url))}`);
  const root = join(REPOSITORY_ROOT, ".tmp", "btcc-live-e2e", "fixture-catalog", identity);
  const catalogPath = join(root, "catalog.json");
  if (existsSync(catalogPath)) return catalogPath;
  mkdirSync(root, { recursive: true });
  const entries = fixtures.map(({ ref, setupKind }) =>
    materializeFixture({ root, ref, setupKind }),
  );
  const catalog: FixtureCatalog = {
    schema: "butler.btcc.live-diagnostic-fixture-catalog.v1",
    entries,
  };
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  return catalogPath;
}

function fixtureRequirements(scenarios: LiveScenario[]): Array<{ ref: string; setupKind: string }> {
  const refs = new Map<string, string>();
  for (const scenario of scenarios) {
    for (const step of scenario.setupSteps) {
      for (const [key, value] of Object.entries(step)) {
        if (
          key.endsWith("Ref") &&
          typeof value === "string" &&
          !value.startsWith("fixture-head:")
        ) {
          const existing = refs.get(value);
          if (existing && existing !== step.kind) {
            throw new Error(`Fixture ref is used by incompatible setup kinds: ${value}`);
          }
          refs.set(value, step.kind);
        }
      }
    }
  }
  return [...refs].sort(([left], [right]) => left.localeCompare(right))
    .map(([ref, setupKind]) => ({ ref, setupKind }));
}

function materializeFixture(input: {
  root: string;
  ref: string;
  setupKind: string;
}): FixtureCatalogEntry {
  const assetPath = join(input.root, "assets", safeName(input.ref));
  if (directorySetup(input.setupKind)) {
    if (input.setupKind === "seed_project_ledger" || input.setupKind === "seed_session_ledger") {
      writeLedgerFixture(assetPath, input.ref);
    } else {
      writeWorkspaceFixture(assetPath, input.ref);
    }
    return {
      ref: input.ref,
      kind: "directory",
      path: relative(input.root, assetPath),
      sha256: hashDirectory(assetPath),
    };
  }
  mkdirSync(join(input.root, "assets"), { recursive: true });
  const textPath = `${assetPath}.md`;
  writeFileSync(textPath, textFixture(input.ref, input.setupKind), "utf8");
  return {
    ref: input.ref,
    kind: "text",
    path: relative(input.root, textPath),
    sha256: digest(readFileSync(textPath)),
  };
}

function writeWorkspaceFixture(root: string, ref: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  mkdirSync(join(root, "remote"), { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: safeName(ref),
    private: true,
    type: "module",
    scripts: { test: "bun test" },
  }, null, 2)}\n`);
  writeFileSync(join(root, "README.md"), [
    "# Isolated BTCC live fixture",
    "",
    `Fixture authority: ${ref}`,
    "",
    "This repository is disposable. Never access or mutate a real user repository.",
    "Only reviewed changes inside this fixture may be promoted back into this fixture.",
    "",
  ].join("\n"));
  writeFileSync(join(root, "SPEC.md"), [
    "# Governing fixture contract",
    "",
    "- Preserve existing public function signatures unless the user request requires a compatible extension.",
    "- Keep all effects inside this isolated repository.",
    "- Add or update executable validation for every implementation change.",
    "- Treat external services as unavailable unless `remote/status.json` says they are ready.",
    "",
  ].join("\n"));
  writeFileSync(join(root, "src", "sample.ts"), [
    "export type SampleRecord = { id: string; enabled: boolean };",
    "",
    "export function normalizeSample(record: SampleRecord): SampleRecord {",
    "  return { ...record, id: record.id.trim() };",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(root, "tests", "sample.test.ts"), [
    "import { expect, test } from \"bun:test\";",
    "import { normalizeSample } from \"../src/sample.ts\";",
    "",
    "test(\"normalizes the stable sample identifier\", () => {",
    "  expect(normalizeSample({ id: \" sample \" , enabled: true })).toEqual({",
    "    id: \"sample\", enabled: true,",
    "  });",
    "});",
    "",
  ].join("\n"));
  writeFileSync(join(root, "remote", "status.json"), `${JSON.stringify({
    ready: false,
    access: "fixture-only",
  }, null, 2)}\n`);
}

function writeLedgerFixture(root: string, ref: string): void {
  for (const directory of [
    "initiatives", "work", "decisions", "risks", "specs", "reports", "plans",
    "handoffs", "references", "roadmaps", "index", "views",
  ]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  const specBody = [
    "# Governing live-fixture specification",
    "",
    `Fixture authority: ${ref}`,
    "",
    "The original user request is the immutable goal authority.",
    "Planning must preserve its constraints, non-goals, authority, and completion conditions.",
    "All repository and external effects must remain within the isolated fixture.",
    "Review implementation behavior against this specification and the original request.",
    "",
  ].join("\n");
  const spec = [
    "---",
    'schema: "project-ledger.spec.v1"',
    'kind: "spec"',
    'id: "SPEC-LIVE-FIXTURE"',
    'logicalId: "SPEC-LIVE-FIXTURE"',
    'concernId: "CONCERN-LIVE-FIXTURE"',
    'parentId: "SPEC-LIVE-FIXTURE-ROOT"',
    'title: "Governing live-fixture specification"',
    'status: "specified"',
    'createdAt: "2026-01-01T00:00:00.000Z"',
    'updatedAt: "2026-01-01T00:00:00.000Z"',
    "---",
    "",
    specBody,
  ].join("\n");
  writeFileSync(join(root, "specs", "governing-spec.md"), spec);
  writeFileSync(join(root, "ledger.md"), specBody);
  writeFileSync(join(root, "project.json"), `${JSON.stringify({
    schema: "project-ledger.project.v1",
    id: "btcc-live-fixture",
    name: "BTCC Live Fixture",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }, null, 2)}\n`);
  writeFileSync(join(root, "ledger.jsonl"), `${JSON.stringify({
    schema: "project-ledger.event.v1",
    ts: "2026-01-01T00:00:00.000Z",
    type: "project_initialized",
    projectId: "btcc-live-fixture",
    source: "btcc-live-diagnostic-fixture",
  })}\n`);
  writeFileSync(join(root, "index", "project.json"), `${JSON.stringify({
    schema: "project-ledger.index.v1",
    project: { id: "btcc-live-fixture", name: "BTCC Live Fixture" },
    issues: [],
    records: [{
      id: "SPEC-LIVE-FIXTURE",
      kind: "spec",
      title: "Governing live-fixture specification",
      status: "specified",
      path: "specs/governing-spec.md",
      logicalId: "SPEC-LIVE-FIXTURE",
      concernId: "CONCERN-LIVE-FIXTURE",
      parentId: "SPEC-LIVE-FIXTURE-ROOT",
    }],
  }, null, 2)}\n`);
}

function textFixture(ref: string, setupKind: string): string {
  if (setupKind === "bind_prior_conversation") return PRIOR_SANDY_MESSAGE;
  if (ref.includes("sandy-access-supersession")) {
    return [
      "# Mandatory fixture access convention",
      "",
      "For this isolated fixture, Sandy state is read only from `remote/status.json`.",
      "Never connect to a real host. This rule supersedes every earlier access instruction.",
      "",
    ].join("\n");
  }
  if (setupKind === "seed_profile") {
    return "# Fixture user profile\n\nRespond in concise Korean and state limitations plainly.\n";
  }
  if (setupKind === "seed_recent_feedback") {
    return "# Recent fixture feedback\n\nPreserve the original goal; do not optimize for incidental noise.\n";
  }
  if (setupKind === "seed_sentinel") {
    return `BTCC_PROTECTED_SENTINEL:${ref}\n`;
  }
  return `# BTCC fixture context\n\nAuthority ref: ${ref}\n`;
}

function directorySetup(kind: string): boolean {
  return [
    "create_fixture_root",
    "seed_repository",
    "seed_project_ledger",
    "seed_session_ledger",
  ].includes(kind);
}

function safeName(ref: string): string {
  return ref.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
