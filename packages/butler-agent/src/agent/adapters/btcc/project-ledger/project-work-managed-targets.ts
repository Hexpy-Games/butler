import type { ExactLedgerTarget } from "./canonical-ledger-reader.ts";
import { loadProjectLedgerCore } from "./project-ledger-core.ts";
import type { ProjectWorkManifest } from "./project-work-codec.ts";
import type { ResolvedProjectWorkScope } from "./project-work-contracts.ts";
import { childPath } from "./project-work-json.ts";

/** Discovers every immutable child owned by one Work, including history and diagnostics. */
export async function managedProjectWorkTargets(
  scope: ResolvedProjectWorkScope,
  manifest: ProjectWorkManifest,
  required: ExactLedgerTarget[],
): Promise<ExactLedgerTarget[]> {
  const core = await loadProjectLedgerCore();
  const targets = [...required];
  for (const entry of core.buildIndex(scope.ledgerRoot).records) {
    if (entry.kind === "work" && entry.id === manifest.workId) continue;
    const filePath = core.projectPath(scope.ledgerRoot, entry.path);
    const data = core.readRecordData(filePath);
    const body = core.readRecordBody(filePath);
    const bodyWorkId = managedBodyWorkId(body);
    if (data?.parentId !== manifest.workId && bodyWorkId !== manifest.workId)
      continue;
    if (!isManagedProjectWorkBody(body)) continue;
    if (entry.kind !== "plan" && entry.kind !== "reference") invalid();
    targets.push({
      id: entry.id,
      kind: entry.kind,
      parentId: manifest.workId,
      path: childPath(scope.ledgerProjectId, entry.kind, entry.id),
    });
  }
  return [
    ...new Map(
      targets.map((item) => [`${item.kind}\0${item.id}`, item]),
    ).values(),
  ];
}

function isManagedProjectWorkBody(body: string | null): boolean {
  if (!body) return false;
  try {
    const schema = String((JSON.parse(body) as { schema?: unknown }).schema ?? "");
    return schema.startsWith("butler.btcc-project-work-");
  } catch {
    return false;
  }
}

function managedBodyWorkId(body: string | null): string | null {
  if (!body) return null;
  try {
    const value = JSON.parse(body) as { workId?: unknown };
    return typeof value.workId === "string" ? value.workId : null;
  } catch {
    return null;
  }
}

function invalid(): never {
  throw new Error("project_work_managed_record_invalid");
}
