/** Indexed canonical settings: theme setting -> current scene tone -> OS. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { readStartupAppearance, lifecycleAppearance } from "../../packages/butler-app/client/electron/startup-appearance.mjs";

const root = process.env.BUTLER_DATA;
assert.ok(root && !relative(tmpdir(), root).startsWith(".."), "isolated BUTLER_DATA inside TMPDIR");
mkdirSync(join(root, "app-server"), { recursive: true });
const manifest = JSON.parse(readFileSync(resolve("packages/butler-app/client/ui/lifecycle-assets/manifest.json"), "utf8"));
const path = join(root, "app-server/butler-client.sqlite");
const db = new DatabaseSync(path);
try {
  db.exec("CREATE TABLE app_settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL)");
  if (process.argv.includes("--owner-scale")) {
    db.exec("CREATE TABLE chats(id INTEGER PRIMARY KEY, payload BLOB); CREATE TABLE events(id INTEGER PRIMARY KEY, chat_id INTEGER)");
    db.exec("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<600) INSERT INTO chats SELECT x,zeroblob(2166667) FROM n");
    db.exec("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<300000) INSERT INTO events SELECT x,x%600+1 FROM n");
    assert.equal(db.prepare("SELECT count(*) AS n FROM chats").get().n, 600);
    assert.equal(db.prepare("SELECT count(*) AS n FROM events").get().n, 300000);
  }
  const write = db.prepare("INSERT OR REPLACE INTO app_settings VALUES ('settings', ?)");
  const times = [];
  for (const kind of ["live", "image", "none"]) for (const setting of ["light", "dark", "auto"]) for (const dark of [false, true]) for (const hour of [0, 12, 23]) {
    const module = { module: "butler.shoreline", params: { realtime: true } };
    const source = kind === "live" ? { kind, ...module } : kind === "image" ? { kind, asset: "wp_" + "a".repeat(32), filter: module } : { kind };
    write.run(JSON.stringify({ wallpaper: { source, motion: "paused" }, appearance_theme: setting, language: "ko" }));
    const now = new Date(2026, 9, 6, hour);
    const start = performance.now();
    const appearance = readStartupAppearance(root);
    const resolved = lifecycleAppearance(appearance, manifest, dark, now);
    times.push(performance.now() - start);
    const scene = kind === "none" ? null : hour === 12 ? "light" : "dark";
    assert.deepEqual(appearance.source, source);
    assert.deepEqual(resolved, { theme: setting === "auto" ? scene ?? (dark ? "dark" : "light") : setting, locale: "ko", reducedMotion: true });
  }
  for (const realtime of [undefined, false, "true"]) {
    assert.equal(lifecycleAppearance({ source: { kind: "live", module: "butler.shoreline", params: { realtime } } }, manifest, false, new Date(2026, 9, 6, 0)).theme, "light");
  }
  write.run(JSON.stringify({ appearance_theme: "light", language: "en" }));
  assert.equal(lifecycleAppearance(readStartupAppearance(root), manifest, true).theme, "light", "latest settings replace prior state");
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT value_json FROM app_settings WHERE key='settings'").all();
  assert.ok(plan.every((row) => !row.detail.includes("SCAN")), "settings uses the key index");
  console.log(JSON.stringify({ result: "PASS setting/scene/OS precedence, live/image/none, latest state, indexed query", reads: times.length,
    medianMs: times.sort((a, b) => a - b)[Math.floor(times.length / 2)], maxMs: Math.max(...times), bytes: statSync(path).size, ownerScale: process.argv.includes("--owner-scale") }));
} finally { db.close(); }
