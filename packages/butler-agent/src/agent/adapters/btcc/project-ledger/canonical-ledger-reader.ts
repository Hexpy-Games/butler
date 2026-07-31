import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjectLedgerCore } from "./project-ledger-core.ts";

export type CanonicalLedgerRecord = {
  id: string;
  kind: string;
  title: string;
  status: string;
  spec: string | null;
  parentId: string | null;
  body: string | null;
};

export async function readCanonicalProjectLedger(projectRoot: string) {
  const core = await loadProjectLedgerCore();
  const index = core.buildIndex(projectRoot);
  const records = index.records.map((record): CanonicalLedgerRecord => {
    const sourcePath = core.projectPath(projectRoot, record.path);
    const data = core.readRecordData(sourcePath) ?? {};
    return {
      id: record.id,
      kind: record.kind,
      title: record.title,
      status: record.status,
      spec: stringValue(data.spec),
      parentId: stringValue(data.parentId),
      body: core.readRecordBody(sourcePath),
    };
  });
  return {
    project: JSON.parse(readFileSync(join(projectRoot, "project.json"), "utf8")) as unknown,
    records,
  };
}

export async function findCanonicalProjectLedgerRecordKinds(
  projectRoot: string,
  recordId: string,
): Promise<string[]> {
  const core = await loadProjectLedgerCore();
  return [...new Set(
    core.buildIndex(projectRoot).records
      .filter((record) => record.id === recordId)
      .map((record) => record.kind),
  )].sort();
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
