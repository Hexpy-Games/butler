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
    const row = db.prepare("SELECT json_extract(value_json, '$.wallpaper') AS wallpaper, json_extract(value_json, '$.main_screen_theme') AS legacy FROM app_settings WHERE key = 'settings'").get();
    const wallpaper = row?.wallpaper ? JSON.parse(row.wallpaper) : null;
    const source = wallpaper?.source ?? { kind: "live", module: row?.legacy === "silk" ? "butler.silk" : "butler.bloom" };
    return { source, reducedMotion: wallpaper?.motion === "paused" };
  } catch { return { source: { kind: "none" } }; }
  finally { db?.close(); }
}

export function startupPoster(source, dist, dark, data = process.env.BUTLER_DATA || join(homedir(), ".butler")) {
  if (source?.kind === "image" && /^wp_[a-f0-9]{32}$/.test(source.asset)) {
    for (const ext of ["webp", "png", "jpg"]) {
      try {
        const file = join(data, "app-server/wallpapers", `${source.asset}.thumb.${ext}`);
        return `data:image/${ext === "jpg" ? "jpeg" : ext};base64,${readFileSync(file).toString("base64")}`;
      } catch { /* Missing asset falls back to the bundled brand poster. */ }
    }
  }
  const keys = smallJson(join(dist, "startup/posters/keys.json"));
  const id = source?.kind === "live" ? source.module : "butler.bloom";
  // Scene art uses one poster in both themes (never invert the artwork).
  const tone = ["butler.dusk", "butler.shoreline", "butler.photo-clouds", "butler.photo-daisies"].includes(id) ? "light" : dark ? "dark" : "light";
  const name = keys[`${id}|${tone}`] ?? keys[`butler.bloom|${dark ? "dark" : "light"}`];
  return name ? `startup/posters/${name}` : null;
}
