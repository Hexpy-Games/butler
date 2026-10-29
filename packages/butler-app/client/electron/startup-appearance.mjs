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

const RISO_SOURCE = { kind: "live", module: "butler.riso-print" };

function startupSource(wallpaper, row) {
  const source = wallpaper?.source;
  if (source) {
    const oldDefault = source.kind === "live" && source.module === "butler.bloom"
      && !source.paramsDark && (!source.params || Object.keys(source.params).length === 0
        || (Object.keys(source.params).length === 1 && source.params.colors === "monochrome"));
    return wallpaper.origin !== "chosen" && oldDefault ? RISO_SOURCE : source;
  }
  if (row?.legacy === "none") return { kind: "none" };
  if (row?.legacy === "silk" || row?.legacy === "curtain") return { kind: "live", module: "butler.silk" };
  const preset = row?.preset;
  if (["aurora", "bloom", "lavender", "morning"].includes(preset))
    return { kind: "live", module: "butler.bloom", params: { colors: preset } };
  if (preset === "custom" && row?.colors) {
    const colors = JSON.parse(row.colors);
    const defaults = ["#32424d", "#555d7c", "#485c70", "#6a7d9a", "#53708d", "#434d70"];
    if (Array.isArray(colors) && colors.length === 6 && colors.every((v) => typeof v === "string" && /^#[a-f0-9]{6}$/i.test(v))
      && colors.some((v, i) => v.toLowerCase() !== defaults[i]))
      return { kind: "live", module: "butler.bloom", params: { colors } };
  }
  return RISO_SOURCE;
}

export function readStartupAppearance(data = process.env.BUTLER_DATA || join(homedir(), ".butler")) {
  const config = smallJson(join(data, "gateways/app.json")).config;
  const configured = typeof config?.dbPath === "string" ? config.dbPath.trim() : null;
  const path = process.env.BUTLER_APP_SERVER_DB?.trim() || configured
    || join(data, "app-server/butler-client.sqlite");
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 0 });
    const row = db.prepare("SELECT json_extract(value_json, '$.wallpaper') AS wallpaper, json_extract(value_json, '$.main_screen_theme') AS legacy, json_extract(value_json, '$.main_screen_theme_preset') AS preset, json_extract(value_json, '$.main_screen_theme_custom_colors') AS colors, json_extract(value_json, '$.appearance_theme') AS theme, json_extract(value_json, '$.text_size') AS text_size, json_extract(value_json, '$.language') AS locale FROM app_settings WHERE key = 'settings'").get();
    const wallpaper = row?.wallpaper ? JSON.parse(row.wallpaper) : null;
    const source = startupSource(wallpaper, row);
    return { source, reducedMotion: wallpaper?.motion === "paused", theme: row?.theme, textSize: row?.text_size, locale: row?.locale };
  } catch { return { source: RISO_SOURCE }; }
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
