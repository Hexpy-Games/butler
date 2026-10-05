/** Admit a cold published-update smoke only when its real anonymous feed is available. */
import { strict as assert } from "node:assert";

const url = "https://api.github.com/repos/Hexpy-Games/butler/releases?per_page=20&page=1";
const headers = { "User-Agent": "Butler updater" };
async function probe() {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  const remaining = Number(response.headers.get("x-ratelimit-remaining"));
  const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
  const body = await response.text();
  console.log(`PUBLIC FEED CAPACITY: ${JSON.stringify({ status: response.status, remaining, reset })}`);
  return { response, remaining, reset, body };
}

let result = await probe();
if ((result.response.status === 403 || result.response.ok) && result.remaining < 12) {
  // This is environment admission, before any App process/test starts. Never
  // retry a failed smoke or change its own discovery/activation deadlines.
  const wait = result.reset - Date.now() + 1000;
  assert.ok(wait > 0 && wait <= 3_601_000, "GitHub did not advertise a valid hourly quota reset");
  console.log(`WAIT PUBLIC FEED RESET: ${wait}ms; App has not started`);
  await Bun.sleep(wait);
  result = await probe();
}
assert.equal(result.response.status, 200, "Anonymous published release discovery is unavailable");
assert.ok(result.remaining >= 12, "Anonymous feed lacks capacity for the complete update smoke");
const releases = JSON.parse(result.body) as Array<{ tag_name: string; draft: boolean; assets: Array<{ name: string }> }>;
assert.ok(releases.some(release => !release.draft && release.tag_name === `v${process.env.CANDIDATE_VERSION}`
  && release.assets.some(asset => asset.name === "app-update-manifest.json")), "Published candidate manifest is missing");
console.log("PASS PUBLIC FEED CAPACITY: real anonymous discovery ready for a fresh App process");
