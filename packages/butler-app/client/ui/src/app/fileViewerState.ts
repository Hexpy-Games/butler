import { create } from "zustand";
import type { SessionArtifactSummary } from "./types.ts";

/** A file open in a conversation's viewer: a stored artifact, or an editable document the documents feature renders. */
export type FileViewerEntry =
  | { kind: "artifact"; id: string; artifact: SessionArtifactSummary }
  | { kind: "document"; id: string; title: string };

export interface SessionFiles {
  entries: FileViewerEntry[];
  activeId: string | null;
  /** The viewer wants the right slot; hiding it keeps the files open. */
  shown: boolean;
  /** When the viewer last took the slot (see raiseRightSlot). */
  raised: number;
}

const EMPTY: SessionFiles = { entries: [], activeId: null, shown: false, raised: 0 };
let lastRaise = 0;

/**
 * Stamps a pane taking the conversation's right slot. The browser and the file viewer share the slot;
 * the pane with the later stamp holds it and the other stays open behind.
 */
export function raiseRightSlot(): number {
  lastRaise += 1;
  return lastRaise;
}

interface FileViewerState {
  sessions: Record<string, SessionFiles>;
  open: (session: string, entry: FileViewerEntry) => void;
  activate: (session: string, id: string) => void;
  close: (session: string, id: string) => void;
  setShown: (session: string, shown: boolean) => void;
}

/** Open files per conversation; not persisted, so a reload starts with none. */
export const useFileViewerState = create<FileViewerState>()((set) => {
  const update = (session: string, next: (files: SessionFiles) => SessionFiles) =>
    set((state) => ({ sessions: { ...state.sessions, [session]: next(state.sessions[session] ?? EMPTY) } }));
  return {
    sessions: {},
    open: (session, entry) => update(session, (files) => {
      const index = files.entries.findIndex((item) => item.id === entry.id);
      const entries = index < 0 ? [...files.entries, entry] : files.entries.map((item, at) => at === index ? entry : item);
      return { entries, activeId: entry.id, shown: true, raised: raiseRightSlot() };
    }),
    activate: (session, id) => update(session, (files) => ({ ...files, activeId: id })),
    close: (session, id) => update(session, (files) => {
      const index = files.entries.findIndex((item) => item.id === id);
      if (index < 0) return files;
      const entries = files.entries.filter((item) => item.id !== id);
      const activeId = files.activeId !== id ? files.activeId : entries[Math.min(index, entries.length - 1)]?.id ?? null;
      return { ...files, entries, activeId, shown: files.shown && entries.length > 0 };
    }),
    setShown: (session, shown) => update(session, (files) => ({ ...files, shown: shown && files.entries.length > 0,
      raised: shown ? raiseRightSlot() : files.raised })),
  };
});

export function useSessionFiles(session: string): SessionFiles {
  return useFileViewerState((state) => state.sessions[session] ?? EMPTY);
}

/** Which pane holds the right slot: the one raised last among those that want it. */
export function rightSlotPane(input: { browser: boolean; browserRaised: number; viewer: boolean; viewerRaised: number }): "browser" | "viewer" | null {
  if (input.browser && input.viewer) return input.browserRaised > input.viewerRaised ? "browser" : "viewer";
  return input.viewer ? "viewer" : input.browser ? "browser" : null;
}
