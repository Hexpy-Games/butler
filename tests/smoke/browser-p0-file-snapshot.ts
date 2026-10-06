import { existsSync, lstatSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { P0App } from "./browser-p0-measure.ts";

type Entry = { bytes: number; mtimeMs: number; kind: string };
type Snapshot = Record<string, Entry>;

/** Every file, including mtime-only changes; symlinks are recorded, not followed. */
export async function snapshotFiles(app: P0App, label: string) {
  const paths = await app.main.evaluate<{ userData: string; sessionData: string }>("browserP0.sample().paths");
  const roots = { data: app.data, profile: paths.userData, ...(paths.sessionData === paths.userData ? {} : { session: paths.sessionData }) };
  const files: Snapshot = {};
  for (const [scope, root] of Object.entries(roots)) walk(root, scope, files);
  writeFileSync(join(app.dir, `${label}-snapshot.json`), JSON.stringify(files));
  if (process.env.BUTLER_P0_EVIDENCE) writeFileSync(join(process.env.BUTLER_P0_EVIDENCE, `${label}-snapshot.json`), JSON.stringify(files));
  return files;
}

function walk(root: string, prefix: string, files: Snapshot) {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name), key = `${prefix}/${name}`, stat = lstatSync(path);
    if (stat.isDirectory()) walk(path, key, files);
    else files[key] = { bytes: stat.size, mtimeMs: stat.mtimeMs, kind: stat.isSymbolicLink() ? "symlink" : "file" };
  }
}

export function fileDelta(before: Snapshot, after: Snapshot) {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed = paths.filter(path => JSON.stringify(before[path]) !== JSON.stringify(after[path])).map(path => ({ path, writerHint: writerHint(path), before: before[path] ?? null, after: after[path] ?? null }));
  const scopes = ["data", "profile", "session"].map(scope => {
    const a = Object.entries(before).filter(([p]) => p.startsWith(`${scope}/`));
    const b = Object.entries(after).filter(([p]) => p.startsWith(`${scope}/`));
    return { scope, beforeFiles: a.length, afterFiles: b.length, fileDelta: b.length - a.length, byteDelta: b.reduce((n, [, e]) => n + e.bytes, 0) - a.reduce((n, [, e]) => n + e.bytes, 0), changedFiles: changed.filter(c => c.path.startsWith(`${scope}/`)).length };
  });
  const writers = Object.fromEntries(["Butler", "Chromium", "unresolved"].map(owner => [owner, changed.filter(c => c.writerHint === owner).length]));
  return { scopes, changed, writers, attribution: "Writer hints inferred from known source/storage paths. Metadata cannot identify transient/reverted writes or prove the initiating PID." };
}

function writerHint(path: string) {
  if (path.startsWith("data/") || /^(profile|session)\/(butler-native-settings|renderer-storage-origin-migration)\.json$/.test(path)) return "Butler";
  // Electron v44.5.1 ElectronBrowserClient::GetGraphiteDawnDiskCacheDirectory owns GraphiteDawnCache.
  if (/^(profile|session)\/(Cache|Code Cache|GPUCache|DawnGraphiteCache|GraphiteDawnCache|DawnWebGPUCache|Network|SharedDictionary|blob_storage)\//.test(path) || /\/(Network Persistent State|TransportSecurity|DIPS(?:-wal|-shm|-journal)?)$/.test(path)) return "Chromium";
  // Chromium 152 btm_utils.h names its internal bounce-tracking database DIPS.
  // LocalStorage and preferences can be initiated by either App JS or Chromium.
  return "unresolved";
}
