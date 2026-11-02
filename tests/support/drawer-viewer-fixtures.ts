import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { Page } from "playwright";

export const DRAWER_SESSION = "general";
const capturedAt = "2026-11-02T01:00:00Z";
const specs = [
  ["release.md", "text", "text/markdown"], ["picture.svg", "image", "image/svg+xml"],
  ["report.pdf", "generic", "application/pdf"], ["page.html", "generic", "text/html"],
] as const;
export const drawerFiles = specs.map(([title, kind, mime_type], index) => {
  const file_id = `file-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const url = `/message-files/${file_id}`;
  return { id: `drawer-${index}`, title, kind: "document", session: DRAWER_SESSION, url: "", capturedAt,
    file: { file_id, url, safe_name: title, kind, mime_type, size_bytes: 256, sha256: "0".repeat(64), created_at: capturedAt } };
});
export const drawerDoc = { id: "editable-doc", kind: "doc", title: "작성한 문서", session: DRAWER_SESSION,
  author: "butler", url: "", capturedAt };
export const drawerOutput = { id: "saved-page", kind: "output", title: "만든 페이지", session: DRAWER_SESSION,
  output: "saved-page", url: "", capturedAt };
const items = [...drawerFiles, drawerDoc, drawerOutput];
const types: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".html": "text/html", ".wasm": "application/wasm" };

/** Offline gateway for the real product library and viewer in VisualHarness. No model or owner data. */
export async function installDrawerGateway(page: Page, dist: string, base: string) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const reply = (data: unknown) => route.fulfill({ json: { ok: true, data } });
    if (url.hostname === "content.localhost") return route.fulfill({ contentType: "text/html", body: "<h1>완성한 페이지</h1>" });
    if (url.origin !== base) return route.abort();
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: readFileSync(join(dist, "index.html"), "utf8") });
    const file = normalize(join(dist, decodeURIComponent(url.pathname)));
    if (file.startsWith(dist + sep) && existsSync(file) && statSync(file).isFile())
      return route.fulfill({ contentType: types[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
    const selected = items.filter((item) => url.searchParams.get("kinds")?.split(",").includes(item.kind) || item.kind === url.searchParams.get("kind"));
    if (url.pathname === "/library") return reply({ items: selected });
    if (url.pathname === "/library/facets") return reply({ total: selected.length, ungrouped: selected.length, tags: [], sites: [] });
    if (url.pathname === "/library/groups") return reply({ groups: [], ungrouped: 0, total: 0 });
    if (url.pathname === "/library/tags") return reply({ tags: [] });
    if (url.pathname === "/documents/editable-doc") return reply({ id: drawerDoc.id, title: drawerDoc.title, body: "# 작성한 문서\n\n세션에서 작성한 본문입니다.",
      chat_id: DRAWER_SESSION, author: "butler", rev: 1, created_at: capturedAt, updated_at: capturedAt });
    if (url.pathname.endsWith("/view")) return reply({ url: "http://content.localhost/page", expires_at: Math.floor(Date.now() / 1000) + 600, revision: 1, revisions: [1] });
    const stored = drawerFiles.find((item) => item.file?.url === url.pathname);
    if (stored) {
      const body = stored.file!.kind === "image" ? '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" fill="teal"/></svg>'
        : stored.title.endsWith(".pdf") ? "%PDF-1.4\n%%EOF" : "# 릴리스 노트\n\n서랍에서 읽는 문서 본문입니다.";
      return route.fulfill({ contentType: stored.file!.mime_type, body });
    }
    if (url.pathname === "/session-queue") return reply({ queued_messages: [] });
    if (["/session-view", "/summary", "/navigation", "/events/live", "/health"].includes(url.pathname)) return reply({});
    return route.fulfill({ status: 404, json: { ok: false, error: { code: "not_found" } } });
  });
}
