import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { Library, NavRow } from "@/butler-ds";

export function LibraryEntry() {
  useAppLocale();
  const active = useButlerStore((state) => state.view.kind === "library");
  return <NavRow icon={<Library />} label={appCopy.browser.library} active={active}
    dataTestClass="library-entry" onClick={() => useButlerStore.getState().setView({ kind: "library" })} />;
}
