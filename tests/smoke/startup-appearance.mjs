/** Real indexed SQLite settings and lifecycle cache selection; no agent or owner data. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, existsSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readStartupAppearance, lifecycleAppearance } from "../../packages/butler-app/client/electron/startup-appearance.mjs";

const root = process.env.BUTLER_DATA;
assert.ok(root && !relative(tmpdir(), root).startsWith(".."), "use isolated BUTLER_DATA inside TMPDIR");
mkdirSync(join(root, "app-server"), { recursive: true });
const dist = join(root, "dist");
const userData = join(root, "profile");
cpSync(resolve("packages/butler-app/client/ui/src/components/lifecycle/stills"), join(dist, "lifecycle/stills"), { recursive: true });
mkdirSync(join(userData, "lifecycle"), { recursive: true });
const keys = JSON.parse(readFileSync(join(dist, "lifecycle/stills/keys.json"), "utf8"));
const db = new DatabaseSync(join(root, "app-server/butler-client.sqlite"));
try {
  db.exec("CREATE TABLE app_settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL)");
  const write = db.prepare("INSERT OR REPLACE INTO app_settings VALUES ('settings', ?)");
  const times = [];
  for (const id of [...Object.keys(keys.modules), "none", "user.missing"]) {
    const source = id === "none" ? { kind: "none" } : { kind: "live", module: id };
    write.run(JSON.stringify({ wallpaper: { source, motion: "paused" }, appearance_theme: "dark", language: "ko" }));
    const start = performance.now();
    const appearance = readStartupAppearance(root);
    const resolved = lifecycleAppearance(appearance, dist, userData, false, root);
    times.push(performance.now() - start);
    assert.deepEqual(appearance.source, source);
    assert.equal(appearance.reducedMotion, true);
    assert.equal(resolved.theme, "dark");
    assert.equal(resolved.locale, "ko");
    if (id === "none") assert.equal(resolved.still, undefined);
    else assert.ok(existsSync(fileURLToPath(resolved.still)), `${id}: bundled fallback exists`);
    if (keys.modules[id]?.shared) {
      const light = lifecycleAppearance({ ...appearance, theme: "light" }, dist, userData, false, root);
      assert.equal(resolved.still, light.still, "scene art is theme-independent");
    }
  }
  const image = lifecycleAppearance({ source: { kind: "image", asset: "wp_" + "a".repeat(32) } }, dist, userData, false, root);
  assert.match(image.still, /bloom/, "missing image thumbnail falls back");
  const source = { kind: "live", module: "butler.bloom", params: { b: 2, a: 1 } };
  const sourceKey = JSON.stringify({ kind: "live", module: "butler.bloom", params: { a: 1, b: 2 } });
  cpSync(fileURLToPath(image.still), join(userData, "lifecycle/still-light.webp"));
  writeFileSync(join(userData, "lifecycle/still.json"), JSON.stringify({ light: { sourceKey, averageColor: "#123456" } }));
  const saved = lifecycleAppearance({ source }, dist, userData, false, root);
  assert.match(saved.still, /still-light.webp/);
  assert.equal(saved.averageColor, "#123456");
  const changed = lifecycleAppearance({ source: { ...source, params: { b: 3, a: 1 } } }, dist, userData, false, root);
  assert.match(changed.still, /bloom/, "stale source key rejected");
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT value_json FROM app_settings WHERE key='settings'").all();
  assert.ok(plan.every((row) => !row.detail.includes("SCAN")), "settings read uses the key index");
  console.log(JSON.stringify({ result: "PASS settings, bundled stills, no wallpaper, scene tone, missing image, matching user still, stale-key rejection, indexed query", reads: times.length,
    medianMs: times.sort((a, b) => a - b)[Math.floor(times.length / 2)], maxMs: Math.max(...times), ownerScale: false }));
} finally { db.close(); }
