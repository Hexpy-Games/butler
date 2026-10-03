/** Configuration/packaging smoke: real SQLite settings and shipped poster assets, no agent. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { readStartupAppearance, startupPoster } from "../../packages/butler-app/client/electron/startup-appearance.mjs";

const root = process.env.BUTLER_DATA;
assert.ok(root && !relative(tmpdir(), root).startsWith(".."), "use an isolated BUTLER_DATA inside TMPDIR");
mkdirSync(join(root, "app-server"), { recursive: true });
const db = new DatabaseSync(join(root, "app-server/butler-client.sqlite"));
db.exec("CREATE TABLE app_settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL)");
const write = db.prepare("INSERT OR REPLACE INTO app_settings VALUES ('settings', ?)");
const dist = resolve("packages/butler-app/client/ui/dist");
const keys = JSON.parse(readFileSync(join(dist, "startup/posters/keys.json"), "utf8"));
const times = [];
for (const id of [...new Set(Object.keys(keys).map((key) => key.split("|")[0])), "none", "user.missing"]) {
  const source = id === "none" ? { kind: "none" } : { kind: "live", module: id };
  write.run(JSON.stringify({ wallpaper: { source, motion: "paused" } }));
  const start = performance.now();
  const appearance = readStartupAppearance(root);
  const poster = startupPoster(appearance.source, dist, false, root);
  times.push(performance.now() - start);
  assert.deepEqual(appearance.source, source);
  assert.equal(appearance.reducedMotion, true);
  assert.ok(existsSync(join(dist, poster)), `${id}: packaged poster exists`);
  if (id === "butler.shoreline" || id === "butler.dusk" || id.startsWith("butler.photo-")) {
    assert.equal(poster, startupPoster(source, dist, true, root), "scene art is theme-independent");
  }
}
assert.match(startupPoster({ kind: "image", asset: "../../private" }, dist, true, root), /bloom/);
assert.match(startupPoster({ kind: "live", module: "../../private" }, dist, true, root), /bloom/);
const plan = db.prepare("EXPLAIN QUERY PLAN SELECT value_json FROM app_settings WHERE key='settings'").all();
assert.ok(plan.every((row) => !row.detail.includes("SCAN")), "settings access must use the key index at owner DB scale");
// No React, DS module graph, network or font dependency in the packaged entry.
const html = readFileSync(join(dist, "startup.html"), "utf8");
assert.match(html, /startup\/startup.js/);
assert.ok(!/type="module"|assets\/|\.woff|https?:/.test(html));
assert.ok(existsSync(join(dist, "startup/mark.png")));
console.log(JSON.stringify({ result: "PASS canonical settings, every bundled poster, fallback, scene tone, indexed query, static package", reads: times.length,
  readAndPosterMedianMs: times.sort((a, b) => a - b)[Math.floor(times.length / 2)], readAndPosterMaxMs: Math.max(...times) }));
db.close();
