import type { Database } from "bun:sqlite";
import type {
  SpaceCommand,
  SpaceGroup,
  SpaceMutationResult,
  SpaceNode,
  SpaceView,
} from "../../interface/protocol/space-contract.ts";
import {
  containerScope,
  moveSpaceNodes,
  orderedChildren,
  requireSpaceNode,
  spaceError,
} from "./space-tree.ts";

type Undo = {
  token: string;
  revision: number;
  nodes: SpaceNode[];
  groups: SpaceGroup[];
  removeNodes: string[];
  removeGroups: string[];
};

export class AppSpaceOrganization {
  private undo: Undo | undefined;
  private smartNotice: SpaceView["smartNotice"];

  constructor(
    private readonly db: Database,
    private readonly appendEvent: (
      type: string,
      payload: Record<string, unknown>,
    ) => void,
  ) {}

  read(): SpaceView {
    const nodes = this.db
      .query<SpaceNode, []>(
        `
      SELECT n.node_key AS key,
        CASE WHEN n.session_id IS NOT NULL THEN 'session' WHEN n.project_id IS NOT NULL THEN 'project' ELSE 'group' END AS kind,
        COALESCE(n.session_id,n.project_id,n.group_id) AS entityId,
        n.parent_key AS parentKey,n.position,n.revision,n.manual_placement AS manualPlacement,
        CASE WHEN n.session_id IS NOT NULL THEN c.project_id WHEN n.group_id IS NOT NULL THEN g.scope_project_id ELSE NULL END AS scopeProjectId
      FROM app_space_nodes n LEFT JOIN chats c ON c.id=n.session_id
      LEFT JOIN app_space_groups g ON g.id=n.group_id ORDER BY n.position,n.node_key
    `,
      )
      .all()
      .map((node) => ({
        ...node,
        manualPlacement: Boolean(node.manualPlacement),
      }));
    return {
      ...(this.smartNotice && this.undo?.revision === this.smartNotice.revision &&
        this.smartNotice.revision === this.db.query<{ revision: number }, []>("SELECT revision FROM app_space_state").get()?.revision
        ? { smartNotice: this.smartNotice } : {}),
      revision: this.db
        .query<
          { revision: number },
          []
        >("SELECT revision FROM app_space_state WHERE singleton=1")
        .get()!.revision,
      nodes,
      groups: this.db
        .query<
          SpaceGroup,
          []
        >("SELECT id,title,scope_project_id AS scopeProjectId,origin FROM app_space_groups ORDER BY id")
        .all(),
    };
  }

  execute(command: SpaceCommand, origin: "manual" | "smart" = "manual", title = "새 그룹"): SpaceMutationResult {
    let nextUndo: Undo | undefined;
    const result = this.db.transaction(() => {
      const before = this.read();
      if (before.revision !== command.expectedRevision)
        spaceError(
          "space_changed",
          "목록이 변경되었습니다. 최신 목록에서 다시 시도해 주세요.",
        );
      let groupId: string | undefined;
      switch (command.action) {
        case "create":
          groupId = this.createGroup(before, command.title, command.parentKey);
          break;
        case "rename":
          this.renameGroup(before, command.groupId, command.title);
          break;
        case "dissolve":
          this.dissolveGroup(before, command.groupId);
          break;
        case "move":
          this.saveNodes(
            moveSpaceNodes(
              before,
              command.sourceKey,
              command.targetKey,
              command.position,
              origin === "smart",
            ).map(node => node.key === command.sourceKey ? { ...node, manualPlacement: origin === "manual" } : node),
          );
          break;
        case "group":
          groupId = this.groupSessions(
            before,
            command.sourceKey,
            command.targetKey,
            title,
            origin,
          );
          break;
        case "pin":
          this.pin(before, command.nodeKey, command.pinned);
          break;
        case "undo":
          this.restoreUndo(command.undoToken, before.revision);
          break;
      }
      const space = this.read();
      if (
        command.action !== "undo" &&
        command.action !== "pin" &&
        space.revision !== before.revision
      ) {
        nextUndo = inverseChange(before, space);
      }
      this.appendEvent("space.changed", { revision: space.revision });
      return {
        space,
        ...(groupId ? { groupId } : {}),
        ...(nextUndo ? { undoToken: nextUndo.token } : {}),
      };
    })();
    this.undo = nextUndo;
    this.smartNotice = origin === "smart" && nextUndo ? { title, undoToken: nextUndo.token, revision: nextUndo.revision } : undefined;
    return result;
  }

  /** Called inside the owning relocation's App transaction, after scope has changed. */
  placeRelocatedSession(sessionId: string, targetKey: string | null, position: "before" | "after" | "inside"): SpaceView {
    this.saveNodes(moveSpaceNodes(this.read(), `s:${sessionId}`, targetKey, position));
    this.undo = undefined;
    return this.read();
  }

  private saveNodes(nodes: SpaceNode[]): void {
    const statement = this.db.query(`
      UPDATE app_space_nodes SET parent_key=?,position=?,manual_placement=?,revision=revision+1
      WHERE node_key=? AND (parent_key IS NOT ? OR position!=? OR manual_placement!=?)
    `);
    for (const node of nodes) {
      statement.run(
        node.parentKey,
        node.position,
        Number(node.manualPlacement),
        node.key,
        node.parentKey,
        node.position,
        Number(node.manualPlacement),
      );
    }
  }

  private createGroup(
    view: SpaceView,
    rawTitle: string,
    parentKey: string | null,
    origin: "manual" | "smart" = "manual",
  ): string {
    const title = groupTitle(rawTitle);
    const scope = containerScope(view, parentKey);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .query("INSERT INTO app_space_groups VALUES(?,?,?,?,?,?)")
      .run(id, title, scope, origin, now, now);
    const siblings = orderedChildren(view, parentKey);
    this.db
      .query(
        "INSERT INTO app_space_nodes(node_key,group_id,parent_key,position) VALUES(?,?,?,?)",
      )
      .run(
        `g:${id}`,
        id,
        parentKey,
        siblings.length ? siblings.at(-1)!.position + 1 : 0,
      );
    return id;
  }

  private renameGroup(view: SpaceView, id: string, title: string): void {
    requireSpaceNode(view, `g:${id}`);
    this.db
      .query("UPDATE app_space_groups SET title=?,updated_at=? WHERE id=?")
      .run(groupTitle(title), new Date().toISOString(), id);
  }

  private dissolveGroup(view: SpaceView, id: string): void {
    const group = requireSpaceNode(view, `g:${id}`);
    const siblings = orderedChildren(view, group.parentKey);
    const children = orderedChildren(view, group.key).map((node) => ({
      ...node,
      parentKey: group.parentKey,
      manualPlacement: true,
    }));
    siblings.splice(
      siblings.findIndex((node) => node.key === group.key),
      1,
      ...children,
    );
    this.saveNodes(siblings.map((node, position) => ({ ...node, position })));
    this.db
      .query("DELETE FROM app_space_nodes WHERE node_key=?")
      .run(group.key);
    this.db.query("DELETE FROM app_space_groups WHERE id=?").run(id);
  }

  private groupSessions(
    view: SpaceView,
    sourceKey: string,
    targetKey: string,
    title: string,
    origin: "manual" | "smart",
  ): string {
    const source = requireSpaceNode(view, sourceKey);
    const target = requireSpaceNode(view, targetKey);
    if (
      sourceKey === targetKey ||
      source.kind !== "session" ||
      target.kind !== "session"
    ) {
      spaceError("space_invalid_group", "서로 다른 두 대화를 선택해 주세요.");
    }
    if (source.scopeProjectId !== target.scopeProjectId)
      spaceError(
        "space_project_boundary",
        "같은 프로젝트의 대화끼리 묶을 수 있습니다.",
      );
    const id = this.createGroup(view, title, target.parentKey, origin);
    const group = requireSpaceNode(this.read(), `g:${id}`);
    const siblings = orderedChildren(view, target.parentKey).filter(
      (node) => node.key !== sourceKey,
    );
    siblings.splice(
      siblings.findIndex((node) => node.key === targetKey),
      1,
      group,
    );
    this.saveNodes(siblings.map((node, position) => ({ ...node, position })));
    this.saveNodes([
      { ...target, parentKey: group.key, position: origin === "smart" ? 1 : 0, manualPlacement: origin === "manual" },
      { ...source, parentKey: group.key, position: origin === "smart" ? 0 : 1, manualPlacement: origin === "manual" },
    ]);
    if (source.parentKey !== target.parentKey) {
      this.saveNodes(
        orderedChildren(this.read(), source.parentKey).map(
          (node, position) => ({ ...node, position }),
        ),
      );
    }
    return id;
  }

  private pin(view: SpaceView, key: string, pinned: boolean): void {
    const node = requireSpaceNode(view, key);
    if (node.kind === "group")
      spaceError(
        "space_invalid_pin",
        "대화 또는 프로젝트를 즐겨찾기에 추가해 주세요.",
      );
    const table = node.kind === "session" ? "chats" : "projects";
    this.db
      .query(`UPDATE ${table} SET pinned=? WHERE id=?`)
      .run(Number(pinned), node.entityId);
  }

  private restoreUndo(token: string, revision: number): void {
    const undo = this.undo;
    if (!undo || undo.token !== token || undo.revision !== revision)
      spaceError("space_undo_expired", "다른 변경이 있어 되돌릴 수 없습니다.");
    const now = new Date().toISOString();
    for (const group of undo.groups) {
      this.db
        .query(
          `INSERT INTO app_space_groups VALUES(?,?,?,?,?,?) ON CONFLICT(id)
        DO UPDATE SET title=excluded.title,updated_at=excluded.updated_at`,
        )
        .run(
          group.id,
          group.title,
          group.scopeProjectId,
          group.origin,
          now,
          now,
        );
    }
    // Restore removed containers before pointing children to them.
    for (const node of undo.nodes.filter((item) => item.kind === "group")) {
      this.db
        .query(
          "INSERT OR IGNORE INTO app_space_nodes(node_key,group_id,parent_key,position) VALUES(?,?,NULL,?)",
        )
        .run(node.key, node.entityId, node.position);
    }
    this.saveNodes(
      undo.nodes.map((node) => ({ ...node, manualPlacement: true })),
    );
    for (const key of undo.removeNodes)
      this.db.query("DELETE FROM app_space_nodes WHERE node_key=?").run(key);
    for (const id of undo.removeGroups)
      this.db.query("DELETE FROM app_space_groups WHERE id=?").run(id);
  }
}

function groupTitle(value: string): string {
  const title = value.trim();
  if (!title || title.length > 120)
    spaceError("space_invalid_title", "그룹 이름은 1~120자로 입력해 주세요.");
  return title;
}

function inverseChange(before: SpaceView, after: SpaceView): Undo {
  const nextNodes = new Map(after.nodes.map((node) => [node.key, node]));
  const nextGroups = new Map(after.groups.map((group) => [group.id, group]));
  const oldNodes = new Set(before.nodes.map((node) => node.key));
  const oldGroups = new Set(before.groups.map((group) => group.id));
  return {
    token: crypto.randomUUID(),
    revision: after.revision,
    nodes: before.nodes.filter(
      (node) =>
        JSON.stringify(node) !== JSON.stringify(nextNodes.get(node.key)),
    ),
    groups: before.groups.filter(
      (group) =>
        JSON.stringify(group) !== JSON.stringify(nextGroups.get(group.id)),
    ),
    removeNodes: after.nodes
      .filter((node) => !oldNodes.has(node.key))
      .map((node) => node.key),
    removeGroups: after.groups
      .filter((group) => !oldGroups.has(group.id))
      .map((group) => group.id),
  };
}
