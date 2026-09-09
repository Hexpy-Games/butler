import { create } from "zustand";
import { initialItems, type SpaceItem } from "./sample-data";

import type { MockState } from "./mock-types";
import { groupSessions, moveTreeItem } from "./tree-move";

export const useMock = create<MockState>((set, get) => ({
  items: initialItems,
  active: "general",
  view: "all",
  expanded: ["health", "products", "butler", "sandy"],
  sidebarOpen: true,
  smart: true,
  dark: new URLSearchParams(window.location.search).get("theme") === "dark",
  dialog: null,
  draft: "",
  draftParts: [],
  reference: null,
  sent: [],
  notice: "",
  undoItems: null,
  open: (active) =>
    set({
      active,
      draft: "",
      draftParts: [],
      reference: null,
      sidebarOpen: window.innerWidth > 640,
    }),
  toggleGroup: (id) =>
    set((s) => ({
      expanded: s.expanded.includes(id)
        ? s.expanded.filter((x) => x !== id)
        : [...s.expanded, id],
    })),
  setDialog: (dialog) => set({ dialog }),
  setView: (view) => set({ view }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleSmart: () => set((s) => ({ smart: !s.smart })),
  toggleTheme: () => set((s) => ({ dark: !s.dark })),
  setDraft: (draft) => set({ draft, draftParts: [{ text: draft }] }),
  syncDraft: (draft, draftParts) => set({ draft, draftParts }),
  attach: (reference) =>
    set({ reference, dialog: null, sidebarOpen: window.innerWidth > 640 }),
  send: () => {
    const s = get();
    if (!s.draft.trim()) return;
    const id = s.active === "new" ? crypto.randomUUID() : s.active;
    let items = s.items.map((item) =>
      item.id === id ? { ...item, updatedAt: Date.now() } : item,
    );
    let notice = "샘플 메시지를 보냈습니다. 모델은 호출하지 않습니다.";
    let undoItems: SpaceItem[] | null = null;
    if (s.active === "new") {
      const session: SpaceItem = {
        id,
        title: s.draft,
        kind: "session",
        parent: null,
        preview: s.draft,
        updatedAt: Date.now(),
      };
      items = [...items, session];
      // Intentional demo fixture, not a classifier or production grouping policy.
      if (s.smart && /여행|오사카|교토/.test(s.draft)) {
        undoItems = items;
        const group = items.find((item) => item.id === "travel");
        if (!group)
          items = [
            ...items,
            {
              id: "travel",
              title: "여행",
              kind: "group",
              parent: null,
              smart: true,
            },
          ];
        items = items.map((item) =>
          item.id === id || (item.id === "kyoto" && item.parent === null)
            ? { ...item, parent: "travel" }
            : item,
        );
        notice = "여행 그룹으로 정리했습니다.";
      }
    }
    set({
      items,
      active: id,
      draft: "",
      draftParts: [],
      reference: null,
      notice,
      undoItems,
      expanded: [...new Set([...s.expanded, "travel"])],
      sent: [...s.sent, { sessionId: id, text: s.draft, parts: s.draftParts }],
    });
  },
  create: (kind, title, context) => {
    const s = get();
    const id = crypto.randomUUID();
    const source = s.active;
    const item: SpaceItem = {
      id,
      title,
      kind: kind === "topic" ? "session" : kind,
      parent: null,
      preview: context,
      source,
      updatedAt: Date.now(),
    };
    const session: SpaceItem = {
      id: `${id}-session`,
      title: "첫 대화",
      kind: "session",
      parent: id,
      preview: context,
      source,
      updatedAt: Date.now(),
    };
    set({
      items: [...s.items, item, ...(kind === "project" ? [session] : [])],
      active:
        kind === "group" ? s.active : kind === "project" ? session.id : id,
      expanded: [...s.expanded, id],
      dialog: null,
      notice: `${title}${kind === "group" ? " 그룹을" : " 대화를"} 만들었습니다. (목업)`,
      draft: "",
      draftParts: [],
      reference: null,
      sidebarOpen: window.innerWidth > 640,
    });
  },
  move: (id, parent) =>
    set((s) => ({
      items: s.items.map((item) =>
        item.id === id ? { ...item, parent } : item,
      ),
      dialog: null,
      undoItems: s.items,
      expanded: parent ? [...s.expanded, parent] : s.expanded,
      notice: parent
        ? `${s.items.find((item) => item.id === parent)?.title} 안으로 옮겼습니다. (목업)`
        : "스페이스 최상위로 옮겼습니다. (목업)",
    })),
  pin: (id) =>
    set((s) => ({
      items: s.items.map((item) =>
        item.id === id ? { ...item, pinned: !item.pinned } : item,
      ),
    })),
  drop: (id, target, position) =>
    set((s) => {
      if (position === "group" && target) {
        const groupId = crypto.randomUUID();
        const items = groupSessions(s.items, id, target, groupId);
        if (!items)
          return { notice: "같은 프로젝트 안의 대화끼리 묶을 수 있습니다." };
        return {
          items,
          undoItems: s.items,
          expanded: [...s.expanded, groupId],
          dialog: { type: "rename-group" as const, id: groupId },
          notice: "두 대화를 새 그룹으로 묶었습니다. (목업)",
        };
      }
      const items = moveTreeItem(s.items, id, target, position);
      if (!items) return { notice: "이 위치에는 옮길 수 없습니다." };
      return {
        items,
        undoItems: s.items,
        expanded:
          target && position === "inside"
            ? [...new Set([...s.expanded, target])]
            : s.expanded,
        notice: "위치와 순서를 변경했습니다. (목업)",
      };
    }),
  renameGroup: (id, title) =>
    set((s) => ({
      items: s.items.map((item) =>
        item.id === id ? { ...item, title } : item,
      ),
      dialog: null,
    })),
  newProjectChat: (projectId) =>
    set((s) => {
      const id = crypto.randomUUID();
      return {
        items: [
          ...s.items,
          {
            id,
            title: "새 대화",
            kind: "session" as const,
            parent: projectId,
            updatedAt: Date.now(),
          },
        ],
        active: id,
        draft: "",
        draftParts: [],
        reference: null,
        expanded: [...new Set([...s.expanded, projectId])],
        sidebarOpen: window.innerWidth > 640,
      };
    }),
  removeItem: (id, operation) =>
    set((s) => {
      const removed = new Set([id]);
      let previousSize = 0;
      while (previousSize !== removed.size) {
        previousSize = removed.size;
        for (const item of s.items)
          if (item.parent && removed.has(item.parent)) removed.add(item.id);
      }
      return {
        items: s.items.filter((item) => !removed.has(item.id)),
        undoItems: s.items,
        active: removed.has(s.active) ? "general" : s.active,
        dialog: null,
        notice: `목업 목록에서 ${operation === "archive" ? "보관" : "삭제"}했습니다. 실제 데이터는 변경하지 않았습니다.`,
      };
    }),
  undo: () =>
    set((s) => ({
      items: s.undoItems ?? s.items,
      undoItems: null,
      notice: "이전 위치로 되돌렸습니다.",
    })),
}));
