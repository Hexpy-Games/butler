// The canonical App settings live in SQLite, not the renderer's localStorage.
// Read one indexed row, read-only, with no busy wait, migrations or agent startup.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

function smallJson(file) {
  try {
    if (statSync(file).size > 65_536) return {};
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function readStartupAppearance(data = process.env.BUTLER_DATA || join(homedir(), ".butler")) {
  const config = smallJson(join(data, "gateways/app.json")).config;
  const configured = typeof config?.dbPath === "string" ? config.dbPath.trim() : null;
  const path = process.env.BUTLER_APP_SERVER_DB?.trim() || configured
    || join(data, "app-server/butler-client.sqlite");
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 0 });
    const row = db.prepare("SELECT json_extract(value_json, '$.wallpaper') AS wallpaper, json_extract(value_json, '$.main_screen_theme') AS legacy, json_extract(value_json, '$.appearance_theme') AS theme, json_extract(value_json, '$.language') AS locale FROM app_settings WHERE key = 'settings'").get();
    const wallpaper = row?.wallpaper ? JSON.parse(row.wallpaper) : null;
    const source = wallpaper?.source ?? { kind: "live", module: row?.legacy === "silk" ? "butler.silk" : "butler.bloom" };
    return { source, reducedMotion: wallpaper?.motion === "paused", theme: row?.theme, locale: row?.locale };
  } catch { return { source: { kind: "live", module: "butler.bloom" } }; }
  finally { db?.close(); }
}

export function lifecycleAppearance(appearance, dist, userData, dark, data = process.env.BUTLER_DATA || join(homedir(), ".butler")) {
  const { source } = appearance;
  const keys = JSON.parse(readFileSync(join(dist, "lifecycle/stills/keys.json"), "utf8"));
  const now = new Date();
  const phase = Math.floor((now.getHours() * 60 + now.getMinutes()) / 15);
  const id = source?.kind === "live" ? source.module : source?.filter?.module;
  const scene = keys.modules[id]?.sceneTone;
  const params = source?.kind === "live" ? source : source?.filter;
  const sceneTone = scene && (params?.params?.[scene.param] ?? scene.default) !== false
    ? scene.darkPhases.some(([start, end]) => phase / 96 >= start && phase / 96 < end) ? "dark" : "light" : null;
  const theme = appearance.theme === "light" || appearance.theme === "dark" ? appearance.theme : sceneTone ?? (dark ? "dark" : "light");
  const shared = keys.modules[id]?.shared;
  const tone = shared ? "light" : theme;
  const result = { theme, locale: appearance.locale, reducedMotion: appearance.reducedMotion, wallpaperKind: source?.kind };
  if (source?.kind === "none") return result;
  const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
  const sourceKey = JSON.stringify(stable(source)) + (keys.modules[id]?.dayPhase ? `|${phase}` : "");
  const stored = smallJson(join(userData, "lifecycle/still.json"));
  const saved = stored[tone];
  const userStill = join(userData, "lifecycle", `still-${tone}.webp`);
  if (saved?.sourceKey === sourceKey) {
    try { if (statSync(userStill).isFile()) return { ...result, still: pathToFileURL(userStill).href, averageColor: saved.averageColor }; } catch { /* Missing still uses bundled fallback. */ }
  }
  if (source?.kind === "image" && /^wp_[a-f0-9]{32}$/.test(source.asset)) {
    for (const ext of ["webp", "png", "jpg"]) {
      try {
        const file = join(data, "app-server/wallpapers", `${source.asset}.thumb.${ext}`);
        if (!statSync(file).isFile()) continue;
        return { ...result, still: pathToFileURL(file).href };
      } catch { /* Missing asset falls back to the bundled brand poster. */ }
    }
  }
  const bucket = Math.floor(phase / 24);
  const entry = keys.stills[`${id}|${tone}|${keys.modules[id]?.dayPhase ? bucket : 0}`] ?? keys.stills[`butler.bloom|${theme}|0`];
  return entry ? { ...result, still: pathToFileURL(join(dist, "lifecycle/stills", entry.file)).href, averageColor: entry.averageColor } : result;
}
