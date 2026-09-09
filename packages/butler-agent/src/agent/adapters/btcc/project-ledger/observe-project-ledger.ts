import type { ProjectLedgerHead } from "./runtime-types.ts";
import { loadProjectLedgerCore } from "./project-ledger-core.ts";

export async function observeProjectLedgerHead(
  projectRoot: string,
  recordPaths?: string[],
): Promise<ProjectLedgerHead> {
  const core = await loadProjectLedgerCore();
  const observed = recordPaths
    ? core.observeProjectLedgerRecordHead(projectRoot, recordPaths)
    : core.observeProjectLedgerSourceHead(projectRoot);
  return {
    schema: "butler.btcc-project-ledger-head.v1",
    projectRoot: observed.projectRoot,
    sourceSha256: observed.sourceSha256,
    sourceFileCount: observed.sourceFileCount,
    storageSha256: observed.storageSha256,
    storageEntryCount: observed.storageEntryCount,
    ...(recordPaths ? { recordPaths } : {}),
  };
}

export function parseHeadRecordPaths(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.some((path) =>
    typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === ".."),
  ) || new Set(value).size !== value.length) throw new Error("project_ledger_record_head_invalid");
  return value;
}
