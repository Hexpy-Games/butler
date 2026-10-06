// The canonical App settings live in SQLite, not the renderer's localStorage.
// Read one indexed row, read-only, with no busy wait, migrations or agent startup.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

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

export function lifecycleAppearance(appearance, manifest, dark, now = new Date()) {
  const { source } = appearance;
  const params = source?.kind === "live" ? source : source?.filter;
  const scene = manifest.sceneTones[params?.module];
  const phase = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000) / 86400;
  const sceneTone = scene && (params?.params?.[scene.param] ?? scene.default) === true
    ? scene.darkPhases.some(([start, end]) => phase >= start && phase < end) ? "dark" : "light" : null;
  const theme = appearance.theme === "light" || appearance.theme === "dark" ? appearance.theme : sceneTone ?? (dark ? "dark" : "light");
  return { theme, locale: appearance.locale, reducedMotion: appearance.reducedMotion };
}
