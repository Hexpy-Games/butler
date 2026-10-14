import { useEffect } from "react";
import { appCopy } from "./copy";
import { useButlerStore } from "./store";
import type { AppView } from "./types";
import { libraryParent, libraryTitle } from "@/components/library/libraryNav";

/** The screen one level up from a nested one (Library levels, a schedule's detail); top-level screens have none. */
export function parentView(view: AppView): AppView | null {
  if (view.kind === "history") return view.from === "settings" ? { kind: "settings", section: "browser" } : { kind: "browser" };
  if (view.kind === "library") return libraryParent(view);
  if (view.kind === "automation-detail") return { kind: "automations" };
  return null;
}

/** The title a view shows in the titlebar when it is nested (the generic titles stay with activeTitleForView). */
export function nestedTitle(view: AppView): string | null {
  if (view.kind === "history") return appCopy.browser.history.title;
  if (view.kind === "browser") return appCopy.browser.title;
  if (view.kind === "library") return libraryTitle(view);
  if (view.kind === "automations") return appCopy.automations.title;
  return null;
}

/** The titlebar back action for the current view, or none at the top level. */
export function useTitlebarBack() {
  const view = useButlerStore((state) => state.view);
  const parent = parentView(view);
  const key = parent ? JSON.stringify(parent) : "";
  const back = parent ? { label: appCopy.library.back(nestedTitle(parent) ?? ""), onBack: () => useButlerStore.getState().setView(parent) } : undefined;
  useEffect(() => {
    if (!key) return;
    const target = JSON.parse(key) as AppView;
    const onKey = (event: KeyboardEvent) => {
      const editable = event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(event.target.tagName));
      const mac = (event.metaKey || event.ctrlKey) && event.key === "[";
      const alt = event.altKey && event.key === "ArrowLeft" && !editable;
      if ((mac || alt) && !event.defaultPrevented) { event.preventDefault(); useButlerStore.getState().setView(target); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key]);
  return back;
}
