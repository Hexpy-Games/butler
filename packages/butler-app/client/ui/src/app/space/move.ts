import { useOrganization } from "./organization";
import type { SpaceRowData } from "./projection";

/** Menu and drag share the same project-boundary decision. */
export function requestSpaceMove(rows: Map<string, SpaceRowData>, sourceKey: string, targetKey: string | null, position: "before" | "after" | "inside") {
  const source = rows.get(sourceKey);
  if (!source) return;
  const target = targetKey ? rows.get(targetKey) : undefined;
  const parentKey = position === "inside" ? targetKey : target?.node.parentKey;
  const parent = parentKey ? rows.get(parentKey) : undefined;
  const projectId = parent?.node.kind === "project" ? parent.node.entityId : parent?.node.scopeProjectId ?? null;
  if (projectId !== source.node.scopeProjectId && source.session) {
    useOrganization.getState().setDialog({ kind: "relocate", sourceKey, targetKey, position, operationId: crypto.randomUUID() });
  } else {
    void useOrganization.getState().mutate({ action: "move", sourceKey, targetKey, position });
  }
}
