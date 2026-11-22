import type { LibraryItem, LibraryKind } from "../../../butler-protocol/src/index.ts";
import { artifactTarget, type ResultTarget } from "../outputs/results";

export function libraryKindParams(kind: LibraryKind): URLSearchParams {
  return new URLSearchParams(kind === "document" ? { kinds: "doc,document" } : { kind });
}

export function libraryQuery(kind: LibraryKind, q: string, cursor: string): string {
  const params = libraryKindParams(kind);
  if (q.trim()) params.set("q", q.trim());
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

export function hasWebSource(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:"; }
  catch { return false; }
}

export function goesToChat(item: LibraryItem): boolean {
  return Boolean(item.session && (item.file || item.output || item.kind === "doc"));
}

export function libraryMeta(item: LibraryItem, locale: string): string {
  const host = hasWebSource(item.url) ? item.site || new URL(item.url).host : undefined;
  return [host, new Date(item.updatedAt ?? item.capturedAt).toLocaleDateString(locale)].filter(Boolean).join(" · ");
}

export function libraryTarget(item: LibraryItem): ResultTarget | null {
  if (item.kind === "doc") return { kind: "doc", id: item.id, title: item.title };
  if (item.file) return artifactTarget({ id: item.id, kind: item.file.kind === "image" ? "image" : item.file.kind === "text" ? "document" : "file",
    title: item.title, file_id: item.file.file_id, safe_path_label: item.file.safe_name, created_at: item.capturedAt });
  if (item.output) return { kind: "output", id: item.output, title: item.title };
  const path = item.image_url ?? item.crop;
  if (path) return { kind: "image", path, title: item.title };
  if (hasWebSource(item.url)) return { kind: "url", url: item.url, title: item.title };
  return null;
}
