export interface SpaceNode {
  key: string;
  kind: "session" | "project" | "group";
  entityId: string;
  parentKey: string | null;
  position: number;
  revision: number;
  manualPlacement: boolean;
  scopeProjectId: string | null;
}

export interface SpaceGroup {
  id: string;
  title: string;
  scopeProjectId: string | null;
  origin: "manual" | "smart";
}

export interface SpaceView {
  smartNotice?: { title: string; undoToken: string; revision: number };
  revision: number;
  nodes: SpaceNode[];
  groups: SpaceGroup[];
}

export type SpaceCommand = { expectedRevision: number } & (
  | { action: "create"; title: string; parentKey: string | null }
  | { action: "rename"; groupId: string; title: string }
  | { action: "dissolve"; groupId: string }
  | {
      action: "move";
      sourceKey: string;
      targetKey: string | null;
      position: "before" | "after" | "inside";
    }
  | { action: "group"; sourceKey: string; targetKey: string }
  | { action: "undo"; undoToken: string }
  | { action: "pin"; nodeKey: string; pinned: boolean }
);

export interface SpaceMutationResult {
  space: SpaceView;
  undoToken?: string;
  groupId?: string;
}

export function isSpaceCommand(value: unknown): value is SpaceCommand {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const text = (key: string) =>
    typeof v[key] === "string" && !!(v[key] as string).trim();
  const keyOrRoot = (key: string) => v[key] === null || text(key);
  if (
    !Number.isSafeInteger(v.expectedRevision) ||
    (v.expectedRevision as number) < 0
  )
    return false;
  switch (v.action) {
    case "create":
      return text("title") && keyOrRoot("parentKey");
    case "rename":
      return text("groupId") && text("title");
    case "dissolve":
      return text("groupId");
    case "move":
      return (
        text("sourceKey") &&
        keyOrRoot("targetKey") &&
        ["before", "after", "inside"].includes(String(v.position))
      );
    case "group":
      return text("sourceKey") && text("targetKey");
    case "undo":
      return text("undoToken");
    case "pin":
      return text("nodeKey") && typeof v.pinned === "boolean";
    default:
      return false;
  }
}
