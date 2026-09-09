import type { SpaceItem } from "./sample-data";
import type { DropPosition } from "./tree-move";
type DialogState = {
  type:
    | "topic"
    | "project"
    | "move"
    | "search"
    | "reference"
    | "group"
    | "rename-group"
    | "rename"
    | "delete-project";
  id?: string;
} | null;
export type DraftPart = { text: string; sessionId?: string };
type SentMessage = { sessionId: string; text: string; parts: DraftPart[] };
export type MockState = {
  items: SpaceItem[];
  active: string;
  view: "all" | "recent" | "running";
  expanded: string[];
  sidebarOpen: boolean;
  smart: boolean;
  dark: boolean;
  dialog: DialogState;
  draft: string;
  draftParts: DraftPart[];
  reference: string | null;
  sent: SentMessage[];
  notice: string;
  undoItems: SpaceItem[] | null;
  open: (id: string) => void;
  toggleGroup: (id: string) => void;
  setDialog: (dialog: DialogState) => void;
  setView: (view: MockState["view"]) => void;
  toggleSidebar: () => void;
  toggleSmart: () => void;
  toggleTheme: () => void;
  setDraft: (draft: string) => void;
  syncDraft: (draft: string, parts: DraftPart[]) => void;
  attach: (id: string | null) => void;
  send: () => void;
  create: (
    kind: "topic" | "project" | "group",
    title: string,
    context: string,
  ) => void;
  move: (id: string, parent: string | null) => void;
  drop: (id: string, target: string | null, position: DropPosition) => void;
  pin: (id: string) => void;
  renameGroup: (id: string, title: string) => void;
  newProjectChat: (id: string) => void;
  removeItem: (id: string, operation: "archive" | "delete") => void;
  undo: () => void;
};
