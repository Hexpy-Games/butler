import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { chromeEnvironment } from "@/app/chromeEnvironment";
import { beginDwell } from "../library/libraryDrop";
import { useElementDrag } from "./elementDrag";
import { Library, NavDropTarget, NavRow, useAdaptiveDrawer } from "@/butler-ds";

export function LibraryEntry() {
  useAppLocale();
  const drawer = useAdaptiveDrawer(chromeEnvironment());
  const dropping = useElementDrag(s => s.target?.kind === "library");
  const active = useButlerStore((state) => state.view.kind === "library");
  return <NavDropTarget onDwell={beginDwell} dwellMs={600} drop={dropping ? "outside" : undefined} hint={appCopy.browser.dropSaveToLibrary}><NavRow icon={<Library />} label={appCopy.browser.library} active={active}
    dataTestClass="library-entry" onClick={() => {
      const store = useButlerStore.getState();
      store.setView({ kind: "library" });
      if (drawer) store.setLeftOpen(false);
    }} /></NavDropTarget>;
}
