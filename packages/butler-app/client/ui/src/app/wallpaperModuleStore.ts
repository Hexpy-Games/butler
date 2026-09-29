// User-authored wallpaper modules (<BUTLER_HOME>/wallpapers/<id>/): loaded from
// the gateway, validated, compile-checked once per change, and merged with the
// built-ins into the one registry every wallpaper and picker uses.
import {
  BUILTIN_WALLPAPERS,
  createWallpaperRegistry,
  defineWallpaperModule,
  trimWallpaperShaderLog,
  validateWallpaperManifest,
  wallpaperModuleRevision,
  type WallpaperError,
  type WallpaperLabel,
  type WallpaperModule,
  type WallpaperModuleCheck,
  type WallpaperRegistry,
  type WallpaperUserModule,
} from "@/butler-ds";
import type { WallpaperModuleListing, WallpaperModuleReport, WallpaperModuleShader, WallpaperModuleStatus } from "./wallpaperModules.ts";

export interface WallpaperModuleStoreDeps {
  list(): Promise<WallpaperModuleListing[]>;
  shader(id: string): Promise<WallpaperModuleShader>;
  /** `overlay.frag` of a two-pass module (`overlay: true`). */
  overlay?(id: string): Promise<string>;
  /** The module's `defaultImage` bytes; read only when a wallpaper or still draws it. */
  image?(id: string): Promise<Blob>;
  /** `revision`: the gateway's revision of the files checked (the shader's ETag), when known. */
  report(id: string, report: WallpaperModuleReport, revision?: string): Promise<void>;
  /**
   * Marks a revision `checking` on the gateway before `check` compiles and draws it, so a check that
   * hangs the GPU (and takes the app down) is found on the next start instead of crash-looping.
   */
  markChecking?(id: string, revision: string): Promise<void>;
  /** Whether `check` can run here (WebGL2); without it nothing is marked, since no verdict would follow. */
  canCheck?(): boolean;
  /** Compile and link once (`checkWallpaperModule`); null without WebGL2. */
  check(module: WallpaperModule): WallpaperModuleCheck | null;
  /** A shown user module stopped working and the default shows instead: one brief notice. */
  notifyFailure(module: WallpaperUserModule): void;
}

export interface WallpaperModuleSnapshot {
  /** Built-ins plus every usable user module. */
  registry: WallpaperRegistry;
  /** User modules in gateway order, usable or not (`error`). */
  userModules: readonly WallpaperUserModule[];
}

export interface WallpaperModuleStore {
  getSnapshot(): WallpaperModuleSnapshot;
  subscribe(listener: () => void): () => void;
  /** Reloads the listing; `ids` (a change event's) also refetch those shaders. Omitted: everything. Coalesced. */
  refresh(ids?: readonly string[]): Promise<void>;
  /** Every wallpaper's error: retires a user module that fails when drawn, and notices a shown one falling back. */
  handleError(error: WallpaperError): void;
}

interface Entry {
  id: string;
  name?: WallpaperLabel;
  /** The listing's manifest as JSON: an unnamed entry is kept only while it is unchanged. */
  manifestKey: string;
  /** Content revision: the module's, or the manifest's while it is invalid. */
  revision: string;
  module?: WallpaperModule;
  /** The gateway's revision of the files read (reports name it). */
  files?: string;
  /** The verdict the gateway should hold; absent while unverified (no WebGL2). */
  verdict?: WallpaperModuleReport;
  status: WallpaperModuleStatus;
}

/** Verdicts that are not the module's content (a taken id, an unreadable file): listed, never reported. */
const LOCAL_REVISIONS = new Set(["taken", "unreadable", "pending-check"]);
/** Revision of a module held back while another client's `checking` mark is younger than the timeout. */
const PENDING_CHECK = "pending-check";

/** Failures when drawn that are the module's own (anything else is the image, the device or the setting). */
const RUNTIME_FAILURES = new Set<WallpaperError["reason"]>(["compile", "link", "degraded", "context-lost"]);

const usable = (entry: Entry) => entry.module !== undefined && entry.verdict?.state !== "error";

function nameOf(manifest: Record<string, unknown>): WallpaperLabel | undefined {
  const { name } = manifest;
  if (typeof name !== "object" || name === null) return undefined;
  const { en, ko } = name as Record<string, unknown>;
  return typeof en === "string" && en.trim() && typeof ko === "string" && ko.trim() ? { en, ko } : undefined;
}

function publicEntry({ id, name, verdict }: Entry): WallpaperUserModule {
  return { id, ...(name ? { name } : {}), ...(verdict?.state === "error" ? { error: verdict.message } : {}) };
}

const failed = (message: string): WallpaperModuleReport => ({ state: "error", message });

/** A `checking` mark older than this is a check that never finished, whoever made it. */
const CHECK_TIMEOUT_MS = 60_000;

/** A `checking` mark this client has seen for longer than the timeout: that check never finished. */
export const HUNG_DURING_CHECK = "hung during check (the app stopped while compiling or drawing it)";

/** The gateway already holds this verdict. */
function holds(status: WallpaperModuleStatus, verdict: WallpaperModuleReport): boolean {
  return status.state === verdict.state && (verdict.state !== "error" || status.message === verdict.message);
}

/** Built-ins plus user modules; the registry is rebuilt only when what it offers changes. */
export function createWallpaperModuleStore(deps: WallpaperModuleStoreDeps): WallpaperModuleStore {
  /** When this client first saw each `checking` mark (`id` + its `checkedAt`), on this client's clock only. */
  const seenMarks = new Map<string, number>();
  const markAge = (id: string, checkedAt: string | undefined) => {
    const key = `${id}\n${checkedAt ?? ""}`;
    const first = seenMarks.get(key) ?? Date.now();
    seenMarks.set(key, first);
    return Date.now() - first;
  };
  /** Set once the store exists: looks at a held-back module again after the timeout. */
  let recheck: (id: string) => void = () => undefined;
  let entries = new Map<string, Entry>();
  let snapshot: WallpaperModuleSnapshot = { registry: BUILTIN_WALLPAPERS, userModules: [] };
  let signature = "";
  const listeners = new Set<() => void>();
  /** Last verdict sent per module (content + verdict), so a lagging gateway is not told twice. */
  const reported = new Map<string, string>();
  const noticed = new Set<string>();

  const publish = () => {
    const list = [...entries.values()];
    const next = list.map((entry) => [entry.id, entry.revision, usable(entry), entry.verdict?.state === "error" ? entry.verdict.message : ""].join("\n")).join("\n\n");
    if (next === signature) return;
    signature = next;
    const modules = list.filter(usable).map((entry) => entry.module!);
    snapshot = { registry: modules.length ? createWallpaperRegistry([...BUILTIN_WALLPAPERS.list(), ...modules]) : BUILTIN_WALLPAPERS, userModules: list.map(publicEntry) };
    for (const listener of listeners) listener();
  };

  const sync = ({ id, revision, verdict, status, files }: Entry) => {
    if (!verdict || LOCAL_REVISIONS.has(revision)) return;
    if (holds(status, verdict)) {
      reported.delete(id);
      return;
    }
    const key = `${revision}\n${verdict.state}\n${verdict.state === "error" ? verdict.message : ""}`;
    if (reported.get(id) === key) return;
    reported.set(id, key);
    deps.report(id, verdict, files).catch(() => {
      if (reported.get(id) === key) reported.delete(id);
    });
  };

  async function settle(listing: WallpaperModuleListing, named: boolean): Promise<Entry> {
    const { id, status, manifest } = listing;
    const previous = entries.get(id);
    const manifestKey = JSON.stringify(manifest);
    if (!named && previous?.manifestKey === manifestKey) return { ...previous, status };
    const base: Pick<Entry, "id" | "name" | "manifestKey" | "status"> = { id, name: nameOf(manifest), manifestKey, status };
    // A taken id is listed but never registered or reported (the gateway owns that verdict).
    if (BUILTIN_WALLPAPERS.get(id)) return { ...base, revision: "taken", verdict: failed("id: taken by a built-in module") };
    const valid = validateWallpaperManifest(manifest);
    if (!valid.ok) {
      const verdict = status.state === "error" && status.message ? failed(status.message) : failed(valid.errors.join("\n"));
      return { ...base, revision: `manifest:${manifestKey}`, verdict };
    }
    let fragment: string;
    let overlay: string | undefined;
    let files: string | undefined;
    try {
      ({ text: fragment, revision: files } = await deps.shader(id));
    } catch {
      return previous ? { ...previous, status } : { ...base, revision: "unreadable", verdict: failed("shader.frag: not readable") };
    }
    if (valid.manifest.overlay) {
      try {
        overlay = await (deps.overlay ?? (() => Promise.reject(new Error("no overlay reader"))))(id);
      } catch {
        return previous ? { ...previous, status } : { ...base, revision: "unreadable", verdict: failed("overlay.frag: not readable") };
      }
    }
    // Read lazily, when a wallpaper or still draws the module; the files' revision names its content.
    const readImage = deps.image;
    const defaultImage = valid.manifest.defaultImage && readImage ? { key: `${id}\n${files ?? manifestKey}`, load: () => readImage(id) } : undefined;
    let module: WallpaperModule;
    try {
      module = defineWallpaperModule({ manifest, fragment, ...(overlay === undefined ? {} : { overlay }), ...(defaultImage ? { defaultImage } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(`${id}: `, "").split("; ").join("\n") : String(error);
      return { ...base, files, revision: `fragment:${manifestKey}\n${fragment}\n${overlay ?? ""}`, verdict: failed(message) };
    }
    const revision = wallpaperModuleRevision(module);
    // Unchanged content keeps its verdict, including a failure when drawn.
    if (previous?.revision === revision) return { ...previous, ...base, files: files ?? previous.files, module: previous.module };
    // First sight of a checked module: the gateway's verdict stands. A `checking` mark is some client's
    // check in progress (maybe one that hung the GPU and took its app down): the module is held back,
    // neither drawn nor checked, until the mark gives way to a verdict or this client has seen it for
    // the timeout, when it counts as a check that never finished and the module is retired.
    const firstSight = !previous || previous.revision === PENDING_CHECK;
    if (firstSight && status.state === "checking") {
      if (markAge(id, status.checkedAt) >= CHECK_TIMEOUT_MS) return { ...base, files, revision, module, verdict: failed(HUNG_DURING_CHECK) };
      setTimeout(() => recheck(id), CHECK_TIMEOUT_MS + 1_000);
      return { ...base, files, revision: PENDING_CHECK };
    }
    if (firstSight && status.state !== "unknown") {
      return { ...base, files, revision, module, verdict: status.state === "ok" ? { state: "ok" } : failed(status.message ?? "error") };
    }
    if (files && deps.markChecking && deps.canCheck?.() !== false) await deps.markChecking(id, files).catch(() => undefined);
    const check = deps.check(module);
    const verdict = check === null ? undefined : check.ok ? { state: "ok" as const } : failed(check.log);
    return { ...base, files, revision, module, ...(verdict ? { verdict } : {}) };
  }

  async function load(ids: ReadonlySet<string> | null) {
    const listings = (await deps.list()).filter((listing) => listing.source === "user");
    const settled = (await Promise.all(listings.map((listing) => settle(listing, ids === null || ids.has(listing.id))))).map((entry) => {
      // Retired while this load was reading (a failure when drawn): the same content keeps that verdict.
      const current = entries.get(entry.id);
      const retired = current?.revision === entry.revision && current.verdict?.state === "error" && entry.verdict?.state !== "error";
      return retired ? { ...entry, verdict: current.verdict } : entry;
    });
    entries = new Map(settled.map((entry) => [entry.id, entry]));
    for (const entry of settled) sync(entry);
    publish();
  }

  let running: Promise<void> | null = null;
  let queued: { ids: Set<string> | null } | null = null;

  async function drain() {
    while (queued) {
      const { ids } = queued;
      queued = null;
      await load(ids).catch(() => undefined);
    }
    running = null;
  }

  const store: WallpaperModuleStore = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh(ids) {
      const all = ids === undefined || queued?.ids === null;
      queued = { ids: all ? null : new Set([...(queued?.ids ?? []), ...ids]) };
      running ??= drain();
      return running;
    },
    handleError(error) {
      const entry = entries.get(error.module);
      if (!entry) return;
      if (RUNTIME_FAILURES.has(error.reason) && usable(entry)) {
        const retired = { ...entry, verdict: failed(trimWallpaperShaderLog(error.message) || error.reason) };
        entries.set(entry.id, retired);
        sync(retired);
        publish();
        return;
      }
      const key = `${entry.id}\n${entry.revision}`;
      if (error.reason !== "unknown-module" || usable(entry) || noticed.has(key)) return;
      noticed.add(key);
      deps.notifyFailure(publicEntry(entry));
    },
  };
  recheck = (id) => void store.refresh([id]);
  return store;
}
