/** Offline headers/JS through the production Rust headless reader and tab executor. */
import { strict as assert } from "node:assert";
import { constants, cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertChromeIdentity, identityFixture } from "../support/browser-identity-fixture";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
const cache = process.env.BUTLER_SMOKE_BROWSER_CACHE, data = process.env.BUTLER_DATA;
assert.ok(cache, "verified temporary Chrome-for-Testing cache required for offline smoke"); assert.ok(data);
cpSync(cache, join(data, "cache"), { recursive: true, mode: constants.COPYFILE_FICLONE });
// The pinned Chrome for Testing version the cache holds.
const [chrome] = readdirSync(join(cache, "chrome-for-testing")); assert.ok(chrome);
const result = join(evidence, "headless-identity.json"), fixture = identityFixture("sandboxed");
try {
  const child = Bun.spawn([resolve("target/debug/examples/browser-identity-smoke")], {
    env: { ...process.env, BUTLER_IDENTITY_FIXTURE_URL: fixture.url, BUTLER_IDENTITY_RESULT: result },
    stdout: Bun.file(join(evidence, "headless-identity.log")), stderr: Bun.file(join(evidence, "headless-identity-errors.log")),
  });
  try {
    assert.equal(await child.exited, 0, readFileSync(join(evidence, "headless-identity-errors.log"), "utf8"));
  } finally { if (child.exitCode === null) { child.kill(); await child.exited; } }
  const out = JSON.parse(readFileSync(result, "utf8"));
  const content = /<pre id="result">([^<]+)<\/pre>/u.exec(out.html)?.[1]; assert.ok(content, out.html);
  const reports = JSON.parse(content);
  assertChromeIdentity(reports, chrome, fixture.requests);
  assert.equal(out.opened.status, "ok"); assert.equal(out.observed.status, "ok");
  writeFileSync(result, JSON.stringify({ reports, opened: out.opened, observed: out.observed, requests: fixture.requests }, null, 2));
  console.log(JSON.stringify({ ok: true, brands: reports.page.js.data.brands, ua: reports.page.js.ua }));
} finally { fixture.server.stop(true); }
