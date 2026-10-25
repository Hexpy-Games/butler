import { useButlerStore } from "@/app/store";
import { rightSlotPane, useSessionFiles } from "@/app/fileViewerState";
import { useBrowserState } from "../browser/browserBridge";
import { useBrowserShellState } from "../browser/browserShellState";

export type RightSlotPane = "browser" | "viewer" | null;

/** The pane in the conversation's right slot: the browser or the file viewer, whichever took it last. */
export function useRightSlot(session: string): RightSlotPane {
  const view = useButlerStore((state) => state.view.kind);
  const browserOpen = useBrowserShellState((state) => Boolean(state.conversations[session]?.open));
  const browserRaised = useBrowserShellState((state) => state.conversations[session]?.raised ?? 0);
  const enabled = useBrowserState((state) => state.enabled);
  const files = useSessionFiles(session);
  if (view !== "session") return null;
  return rightSlotPane({ browser: browserOpen && enabled && Boolean(window.butlerBrowser), browserRaised,
    viewer: files.shown && files.entries.length > 0, viewerRaised: files.raised });
}
