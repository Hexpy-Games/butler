import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { useElementDrag } from "./elementDrag";
import { Library, NavDropTarget, NavRow } from "@/butler-ds";

export function LibraryEntry() {
  useAppLocale();
  const dropping = useElementDrag(s => s.target?.kind === "library");
  const active = useButlerStore((state) => state.view.kind === "library");
  return <NavDropTarget drop={dropping ? "outside" : undefined} hint={appCopy.browser.dropSaveToLibrary}><NavRow icon={<Library />} label={appCopy.browser.library} active={active}
    dataTestClass="library-entry" onClick={() => useButlerStore.getState().setView({ kind: "library" })} /></NavDropTarget>;
}
