import type { ProjectLedgerHead } from "./runtime-types.ts";
import { loadProjectLedgerCore } from "./project-ledger-core.ts";

export async function observeProjectLedgerHead(
  projectRoot: string,
): Promise<ProjectLedgerHead> {
  const core = await loadProjectLedgerCore();
  const observed = core.observeProjectLedgerSourceHead(projectRoot);
  return {
    schema: "butler.btcc-project-ledger-head.v1",
    projectRoot: observed.projectRoot,
    sourceSha256: observed.sourceSha256,
    sourceFileCount: observed.sourceFileCount,
    storageSha256: observed.storageSha256,
    storageEntryCount: observed.storageEntryCount,
  };
}
