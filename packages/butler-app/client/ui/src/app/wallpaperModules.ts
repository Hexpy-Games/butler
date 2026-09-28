// Wallpaper modules on the gateway (`/wallpaper-modules`): the listing (built-in
// and user-authored, with each user module's check status), a user module's
// shader text, and the client's status reports after it compiles one.
import type { TimelineEvent } from "./types.ts";
import {
  unwrapWallpaperBridge,
  wallpaperBridgeMethod,
  wallpaperGatewayRequest,
  wallpaperResponseError,
} from "./wallpaperGateway.ts";

export type WallpaperModuleState = "unknown" | "ok" | "error";

/** A module's check status as the gateway stores it (per module content; a change resets it to `unknown`). */
export interface WallpaperModuleStatus {
  state: WallpaperModuleState;
  message?: string;
  checkedAt?: string;
}

/** One listed module: `manifest` is its `wallpaper.json` as parsed (it may be invalid). */
export interface WallpaperModuleListing {
  id: string;
  source: "builtin" | "user";
  status: WallpaperModuleStatus;
  manifest: Record<string, unknown>;
}

/** What the client reports after checking a user module. */
export type WallpaperModuleReport = { state: "ok" } | { state: "error"; message: string };

type UnknownRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is UnknownRecord => typeof value === "object" && value !== null && !Array.isArray(value);

function parseStatus(raw: unknown): WallpaperModuleStatus {
  if (!isRecord(raw) || (raw.state !== "ok" && raw.state !== "error")) return { state: "unknown" };
  return {
    state: raw.state,
    ...(typeof raw.message === "string" ? { message: raw.message } : {}),
    ...(typeof raw.checkedAt === "string" ? { checkedAt: raw.checkedAt } : {}),
  };
}

function parseListing(raw: unknown): WallpaperModuleListing[] {
  if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id) return [];
  const { source, status, ...manifest } = raw;
  return [{ id: raw.id, source: source === "user" ? "user" : "builtin", status: parseStatus(status), manifest }];
}

/** Every module the gateway knows, built-in and user-authored (invalid user manifests included, as `error`). */
export async function listWallpaperModules(): Promise<WallpaperModuleListing[]> {
  const data = await wallpaperGatewayRequest<{ modules?: unknown }>("listWallpaperModules", undefined, "/wallpaper-modules");
  return Array.isArray(data?.modules) ? data.modules.flatMap(parseListing) : [];
}

const modulePath = (id: string, suffix: string) => `/wallpaper-modules/${encodeURIComponent(id)}/${suffix}`;

/** A user module's `shader.frag` (GLSL body) and the revision of its files (the response's ETag), when given. */
export interface WallpaperModuleShader {
  text: string;
  revision?: string;
}

/** An ETag without its weak prefix and quotes. */
function etagRevision(etag: string | null | undefined): string | undefined {
  const revision = etag?.replace(/^W\//u, "").replace(/^"|"$/gu, "");
  return revision || undefined;
}

/** A user module's shader text, with the revision to report its check against. */
export async function readWallpaperModuleShader(id: string): Promise<WallpaperModuleShader> {
  const method = wallpaperBridgeMethod("readWallpaperModuleShader");
  if (method) {
    const { text, revision } = unwrapWallpaperBridge<{ text: string; revision?: string }>(await method({ id }));
    const checked = etagRevision(revision);
    return { text, ...(checked ? { revision: checked } : {}) };
  }
  const response = await fetch(modulePath(id, "shader"));
  if (!response.ok) throw await wallpaperResponseError(response);
  const revision = etagRevision(response.headers.get("etag"));
  return { text: await response.text(), ...(revision ? { revision } : {}) };
}

/** A user module's `overlay.frag` (two-pass modules). */
export async function readWallpaperModuleOverlay(id: string): Promise<string> {
  const method = wallpaperBridgeMethod("readWallpaperModuleOverlay");
  if (method) return unwrapWallpaperBridge<{ text: string }>(await method({ id })).text;
  const response = await fetch(modulePath(id, "overlay"));
  if (!response.ok) throw await wallpaperResponseError(response);
  return response.text();
}

/** A user module's default image (its manifest `defaultImage`) as encoded bytes. */
export async function readWallpaperModuleImage(id: string): Promise<Blob> {
  const method = wallpaperBridgeMethod("readWallpaperModuleImage");
  if (method) {
    const { bytes, mimeType } = unwrapWallpaperBridge<{ bytes: ArrayBuffer; mimeType?: string }>(await method({ id }));
    return new Blob([bytes], mimeType ? { type: mimeType } : {});
  }
  const response = await fetch(modulePath(id, "image"));
  if (!response.ok) throw await wallpaperResponseError(response);
  return response.blob();
}

/**
 * Stores the client's check verdict for a user module (the agent reads it
 * back). `revision` names the files checked; the gateway refuses the report
 * (409 `wallpaper_module_changed`) when they changed since.
 */
export async function reportWallpaperModuleStatus(id: string, report: WallpaperModuleReport, revision?: string): Promise<void> {
  const body = { ...report, ...(revision ? { revision } : {}) };
  await wallpaperGatewayRequest("reportWallpaperModuleStatus", { id, ...body }, modulePath(id, "status"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Zip archives the import tile's file chooser offers; the gateway validates the bytes regardless. */
export const WALLPAPER_MODULE_IMPORT_ACCEPT = ".zip,application/zip";
/** The gateway's limit on a module archive (its shaders and default image); larger files are refused before uploading. */
export const WALLPAPER_MODULE_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

/** An import failure the gateway explains; `message` is empty without one, so a toast can fall back to its own copy. */
function importError(code: unknown, status: unknown, message: unknown): Error {
  return Object.assign(new Error(typeof message === "string" ? message : ""), {
    code: typeof code === "string" ? code : "request_failed",
    ...(typeof status === "number" ? { status } : {}),
  });
}

async function importOverHttp(file: File): Promise<unknown> {
  const form = new FormData();
  form.set("file", file, file.name);
  const response = await fetch("/wallpaper-modules/import", { method: "POST", body: form });
  const body = (await response.json().catch(() => null)) as { data?: unknown; error?: { code?: unknown; message?: unknown } } | null;
  if (!response.ok) throw importError(body?.error?.code, response.status, body?.error?.message);
  return body?.data;
}

/**
 * Installs a user module from a `.zip` (at most 2 MB; the gateway validates
 * it, rejecting path traversal and symlinks) and returns it as a listing
 * entry. A failure keeps the gateway's own message — imports fail for many
 * specific reasons, unlike the small enumerable set of image-upload errors.
 */
export async function importWallpaperModule(file: File): Promise<WallpaperModuleListing> {
  if (file.size > WALLPAPER_MODULE_IMPORT_MAX_BYTES) throw importError("wallpaper_module_archive_too_large", 413, undefined);
  const method = wallpaperBridgeMethod("importWallpaperModule");
  const data = method
    ? unwrapWallpaperBridge<unknown>(await method({ name: file.name, bytes: await file.arrayBuffer() }))
    : await importOverHttp(file);
  const [listing] = parseListing(data);
  if (!listing) throw importError(undefined, undefined, undefined);
  return listing;
}

/** Rejects with `wallpaper_module_in_use` (409) while a setting or project still draws with the module. */
export async function deleteWallpaperModule(id: string): Promise<void> {
  await wallpaperGatewayRequest("deleteWallpaperModule", { id }, `/wallpaper-modules/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** The gateway's `wallpaper_module_in_use` conflict deleting a module a setting or project still draws with. */
export function wallpaperModuleInUse(error: unknown): boolean {
  const { code, status } = (error && typeof error === "object" ? error : {}) as { code?: unknown; status?: unknown };
  return code === "wallpaper_module_in_use" || status === 409;
}

/**
 * The module ids a `wallpaper.modules.updated` event names (files under
 * `<BUTLER_HOME>/wallpapers/` changed); empty when it names none (reload
 * every module); null for other events.
 */
export function wallpaperModulesChanged(event: TimelineEvent): string[] | null {
  if (event.type !== "wallpaper.modules.updated") return null;
  const ids = (event.payload as UnknownRecord | undefined)?.ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}
