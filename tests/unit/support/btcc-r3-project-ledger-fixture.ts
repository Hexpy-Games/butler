import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];

export function clearProjectFixtures(): void {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function projectFixture() {
  const root = mkdtempSync(join(tmpdir(), "btcc-r3-project-ledger-"));
  roots.push(root);
  const butlerData = join(root, "data");
  const workspace = join(root, "workspace", "fixture-project");
  mkdirSync(workspace, { recursive: true });
  const core = await loadProjectLedgerCore();
  const previous = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = butlerData;
  let ledgerRoot: string;
  try {
    core.initProject({ project: workspace, id: "fixture-project", name: "Fixture" });
    ledgerRoot = core.ledgerRoot(workspace);
  } finally {
    if (previous === undefined) delete process.env.BUTLER_DATA;
    else process.env.BUTLER_DATA = previous;
  }
  return { root, ledgerRoot, core };
}

async function loadProjectLedgerCore() {
  const root = "../../../packages/project-ledger/src";
  const [commands, fileSystem, lifecycle, recordCommands] = await Promise.all([
    import(`${root}/commands.js`),
    import(`${root}/fs.js`),
    import(`${root}/lifecycle-commands.js`),
    import(`${root}/record-commands.js`),
  ]);
  return {
    initProject: commands.initProject,
    ledgerRoot: fileSystem.ledgerRoot,
    createRecord: recordCommands.createRecord,
    createWork: lifecycle.createWork,
  };
}
