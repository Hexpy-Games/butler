import type { AppView } from "./types";
/** The document id travels in the URL so a drawer document survives a reload. */
export function initialDocumentView(): AppView {
  const id = typeof window === "undefined" ? null : new URL(window.location.href).searchParams.get("doc");
  return id ? { kind: "library", section: "document", doc: id } : { kind: "session" };
}
export function persistDocumentView(view: AppView) {
  const url = new URL(window.location.href);
  if (view.kind === "library" && view.doc) url.searchParams.set("doc", view.doc);
  else url.searchParams.delete("doc");
  window.history.replaceState(window.history.state, "", url);
}
