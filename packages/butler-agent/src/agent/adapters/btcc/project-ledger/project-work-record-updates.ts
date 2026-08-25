import type { DurableWorkView } from "../../../btcc/work/index.ts";
import { readStableExactProjectLedgerSnapshot } from "./canonical-ledger-reader.ts";
import type { ProjectLedgerRecordUpdate } from "./external-effect-record-update.ts";
import { loadProjectLedgerCore } from "./project-ledger-core.ts";
import {
  canonicalProjectWorkChildBody,
  decodeChild,
  type ProjectWorkChild,
} from "./project-work-child-codec.ts";
import { PROJECT_WORK_SPEC, type ProjectWorkManifest } from "./project-work-codec.ts";
import type {
  ProjectWorkOperationIdentity,
  ResolvedProjectWorkScope,
} from "./project-work-contracts.ts";
import { childPath } from "./project-work-json.ts";
import {
  childItem,
  manifestForView,
  mutableWorkUpdate,
} from "./project-work-mapping.ts";
import type { CurrentProjectWorkSnapshot } from "./project-work-snapshot.ts";

export async function immutableChildUpdate(input: {
  scope: ResolvedProjectWorkScope;
  workId: string;
  id: string;
  kind: "plan" | "reference";
  title: string;
  child: ProjectWorkChild;
}): Promise<ProjectLedgerRecordUpdate | null> {
  const path = childPath(input.scope.ledgerProjectId, input.kind, input.id);
  const target = { id: input.id, kind: input.kind, path, parentId: input.workId };
  const snapshot = await readStableExactProjectLedgerSnapshot({
    projectRoot: input.scope.ledgerRoot,
    targets: [target],
  });
  const body = canonicalProjectWorkChildBody(input.child);
  if (!snapshot.records[0]) {
    const core = await loadProjectLedgerCore();
    if (
      core
        .buildIndex(input.scope.ledgerRoot)
        .records.some((record) => record.id === input.id)
    )
      throw new Error("project_work_immutable_identity_ambiguous");
    return {
      operation: "create",
      kind: input.kind,
      id: input.id,
      parentId: input.workId,
      title: input.title,
      status: "active",
      spec: PROJECT_WORK_SPEC,
      body,
    };
  }
  const core = await loadProjectLedgerCore();
  const data = core.readRecordData(core.projectPath(input.scope.ledgerRoot, path));
  if (
    !data ||
    data.spec !== PROJECT_WORK_SPEC ||
    data.schema !== `project-ledger.${input.kind}.v1`
  )
    throw new Error("project_work_immutable_metadata_conflict");
  decodeChild(snapshot.records[0].body, {
    schema: input.child.schema,
    workId: input.workId,
    recordId: input.id,
  });
  if (snapshot.records[0].body !== body)
    throw new Error("project_work_immutable_content_conflict");
  return null;
}

export async function projectWorkViewUpdates(input: {
  scope: ResolvedProjectWorkScope;
  current: CurrentProjectWorkSnapshot;
  view: DurableWorkView;
  operationIdentity: ProjectWorkOperationIdentity;
  children: ProjectWorkChild[];
  revisions: Parameters<typeof manifestForView>[0]["revisions"];
  bindingRefs?: ProjectWorkManifest["bindingRefs"];
  createWork?: boolean;
  leadingUpdates?: ProjectLedgerRecordUpdate[];
  material: Parameters<typeof manifestForView>[0]["material"];
}): Promise<ProjectLedgerRecordUpdate[]> {
  const manifest = manifestForView({
    prior: input.current.manifest,
    view: input.view,
    scope: input.scope,
    operationIdentity: input.operationIdentity,
    bindingRefs: input.bindingRefs ?? input.current.manifest.bindingRefs,
    revisions: input.revisions,
    material: input.material,
  });
  const updates = [
    ...(input.leadingUpdates ?? []),
    mutableWorkUpdate(manifest, input.createWork ?? false),
  ];
  for (const child of input.children) {
    const update = await immutableChildUpdate({
      scope: input.scope,
      workId: input.current.view.workId,
      ...childItem(child),
      child,
    });
    if (update) updates.push(update);
  }
  return updates;
}
