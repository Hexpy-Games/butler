// test-category: race
// Real Chromium: retain a CDP read handle across process exit, as restricted Bun
// runners can do. The smoke must finish, release all pipes, and leave no PID.
import { strict as assert } from "node:assert";
import type { Readable, Writable } from "node:stream";
import { launchSmokeBrowser, ownedBrowserProcess } from "../support/smoke-browser.ts";

const browser = await launchSmokeBrowser();
try {
  for (let cell = 0; cell < 2; cell++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<h1>Shutdown fixture</h1><iframe src="about:blank"></iframe>');
    assert.equal(await page.locator("h1").textContent(), "Shutdown fixture");
    const owner = ownedBrowserProcess(context.browser()!);
    // Stop reading before Browser.close. The browser exits, but Bun otherwise
    // retains fd 4 even after ChildProcess.close; ESRCH doesn't release that fd.
    (owner.stdio[4] as Readable).pause();
    const start = performance.now();
    await context.close();
    const durationMs = performance.now() - start;
    assert(durationMs < 10_000, "Owned browser closed within its existing deadline");
    assert(owner.exitCode !== null || owner.signalCode !== null, "Owned child was reaped");
    assert(owner.stdio.every(stream => !stream || stream.destroyed), "All owned pipes were released");
    assert.throws(() => process.kill(owner.pid!, 0), { code: "ESRCH" });
    console.log(JSON.stringify({ cell, pid: owner.pid, durationMs, remainingProcesses: 0 }));
  }
} finally { await browser.close(); }
// Closing the wrapper again is idempotent, including the empty owned set.
await browser.close();

// A live Chromium that ignores the graceful command must still fail cleanup.
const stalled = await launchSmokeBrowser();
const page = await stalled.newPage();
await page.setContent("<h1>Live shutdown failure</h1>");
assert.equal(await page.locator("h1").textContent(), "Live shutdown failure");
const owner = ownedBrowserProcess(page.context().browser()!);
const exit = new Promise<void>(resolve => owner.once("exit", () => resolve()));
const pipe = owner.stdio[3] as Writable;
const write = pipe.write;
pipe.write = () => true;
const start = performance.now();
try { await assert.rejects(stalled.close(), /Owned smoke browser .* did not close/); }
finally { pipe.write = write; }
await exit;
assert(owner.stdio.every(stream => !stream || stream.destroyed), "Forced exit released every owned pipe");
assert.throws(() => process.kill(owner.pid!, 0), { code: "ESRCH" });
await assert.rejects(stalled.close(), /Owned smoke browser .* did not close/);
console.log(JSON.stringify({ forcedKillRejected: true, pid: owner.pid, durationMs: performance.now() - start, remainingProcesses: 0 }));
