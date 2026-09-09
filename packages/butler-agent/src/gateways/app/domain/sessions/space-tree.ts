import type {
  SpaceNode,
  SpaceView,
} from "../../interface/protocol/space-contract.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";

export function spaceError(code: string, message: string): never {
  throw new AppStoreOperationError(409, code, message);
}

export function requireSpaceNode(view: SpaceView, key: string): SpaceNode {
  const node = view.nodes.find((item) => item.key === key);
  if (!node)
    spaceError(
      "space_item_missing",
      "항목을 찾을 수 없습니다. 목록을 새로 확인해 주세요.",
    );
  return node;
}

export function containerScope(
  view: SpaceView,
  parentKey: string | null,
): string | null {
  if (parentKey === null) return null;
  const parent = requireSpaceNode(view, parentKey);
  if (parent.kind === "session")
    spaceError("space_invalid_parent", "대화 안에 항목을 넣을 수 없습니다.");
  return parent.kind === "project" ? parent.entityId : parent.scopeProjectId;
}

export function requirePlacement(
  view: SpaceView,
  source: SpaceNode,
  parentKey: string | null,
): void {
  if (source.scopeProjectId !== containerScope(view, parentKey)) {
    spaceError(
      "space_project_boundary",
      "프로젝트 소속을 바꾸려면 프로젝트 이동을 사용해 주세요.",
    );
  }
  const byKey = new Map(view.nodes.map((node) => [node.key, node]));
  let cursor = parentKey;
  while (cursor) {
    if (cursor === source.key)
      spaceError("space_cycle", "항목을 자신의 하위로 옮길 수 없습니다.");
    cursor = byKey.get(cursor)?.parentKey ?? null;
  }
}

export function orderedChildren(
  view: SpaceView,
  parentKey: string | null,
): SpaceNode[] {
  return view.nodes
    .filter((node) => node.parentKey === parentKey)
    .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
}

/** Returns only the two affected sibling lists; descendants keep their identity and placement. */
export function moveSpaceNodes(
  view: SpaceView,
  sourceKey: string,
  targetKey: string | null,
  position: "before" | "after" | "inside",
  prepend = false,
): SpaceNode[] {
  const source = requireSpaceNode(view, sourceKey);
  if (sourceKey === targetKey) return [];
  const target = targetKey === null ? null : requireSpaceNode(view, targetKey);
  if (!target && position !== "inside")
    spaceError("space_invalid_target", "이동 위치를 선택해 주세요.");
  const parentKey = position === "inside" ? targetKey : target!.parentKey;
  requirePlacement(view, source, parentKey);
  const from = orderedChildren(view, source.parentKey).filter(
    (node) => node.key !== sourceKey,
  );
  const to =
    source.parentKey === parentKey ? from : orderedChildren(view, parentKey);
  const index =
    position === "inside"
      ? (prepend ? 0 : to.length)
      : to.findIndex((node) => node.key === targetKey) +
        (position === "after" ? 1 : 0);
  to.splice(index, 0, { ...source, parentKey, manualPlacement: true });
  const normalize = (nodes: SpaceNode[]) =>
    nodes.map((node, index) => ({ ...node, position: index }));
  return source.parentKey === parentKey
    ? normalize(to)
    : [...normalize(from), ...normalize(to)];
}
