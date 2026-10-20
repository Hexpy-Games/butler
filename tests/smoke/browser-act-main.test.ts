// test-category: race
// Execute origin/main's actual act implementation and this branch with identical
// stubbed renderer events; strip only desktop evidence, as the provider boundary does.
import { test, expect, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
mock.module("electron", () => ({ app: { on() {} }, BrowserWindow: class {}, WebContentsView: class {}, ipcMain: { on() {}, handle() {} }, nativeImage: {}, session: {}, powerMonitor: {}, clipboard: {}, dialog: {} }));
const directory = resolve("packages/butler-app/client/electron/browser");
async function fromRevision(revision: string) {
  const result = Bun.spawnSync(["git", "show", `${revision}:packages/butler-app/client/electron/browser/act.mjs`]);
  expect(result.exitCode).toBe(0);
  const source = result.stdout.toString().replace(/from "(\.\/[^"]+)"/gu, (_, file) => `from "${pathToFileURL(resolve(directory, file)).href}"`);
  const scratch = await mkdtemp(resolve(tmpdir(), "act-main-"));
  try {
    const file = resolve(scratch, "act.mjs");
    await writeFile(file, source);
    return await import(file);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
const main = await fromRevision("origin/main");
const branch = process.env.BUTLER_ACT_REVISION ? await fromRevision(process.env.BUTLER_ACT_REVISION)
  : await import(pathToFileURL(resolve(directory, "act.mjs")).href);
function subject(ending: string) {
  const tab: any = { id: "t", epoch: 1, url: "https://example.com/a", owner: "conversation:s", holder: "agent" };
  const contents: any = new EventEmitter();
  const image: any = { resize: () => image, toBitmap: () => Buffer.alloc(4), toJPEG: () => Buffer.from("image"), isEmpty: () => false };
  Object.assign(contents, {
    debugger: new EventEmitter(), isDestroyed: () => false, isLoading: () => false,
    capturePage: async () => image,
    executeJavaScriptInIsolatedWorld: async (_world: number, scripts: any[]) => {
      if (scripts[0].code.startsWith("new Promise(done=>requestAnimationFrame")) {
        if (ending === "dialog") tab.dialog = { id: "d", epoch: 1, type: "confirm", message: "Confirm", deadline: 1000 };
        if (ending === "navigation") { tab.url = "https://example.com/b"; tab.epoch = 2; }
      }
      return 1;
    },
    navigationHistory: { getActiveIndex: () => 1, length: () => 2, getEntryAtIndex: () => ({ url: "https://example.com/b" }), goBack: () => {} },
  });
  tab.view = { webContents: contents };
  return tab;
}
for (const ending of ["single", "multi", "dialog", "navigation"]) test(`model act bytes match main: ${ending}`, async () => {
  const run = async (implementation: any) => {
    const tab = subject(ending);
    const steps = ending === "navigation" ? [{ action: "back" }] : Array.from({ length: ending === "multi" || ending === "dialog" ? 2 : 1 }, () => ({ action: "wait", value: "50" }));
    const args: any = { observation: "o", steps };
    args.prepared_steps = (await implementation.prepareBatch(tab, args)).steps;
    const result = await implementation.actBatch(tab, args, "s");
    await tab.stillCapture;
    return JSON.stringify(result, (key, value) => ["still", "still_file", "still_pending"].includes(key) ? undefined : value);
  };
  expect(await run(branch)).toBe(await run(main));
});

test("dialog answer sends its still through the durable delivery callback", async () => {
  const { answerDialog } = await import(pathToFileURL(resolve(directory, "dialogs.mjs")).href);
  const tab = subject("single");
  tab.dialog = { id: "d", epoch: 1, callback() {} };
  tab.pendingBatch = [{ status: "completed" }, { status: "unknown", reason: "dialog_pending" }];
  const values: any[] = [];
  tab.pendingStill = { id: "original-act", session: "s", deliver: async (value: any) => { values.push(value); } };
  const result = await answerDialog({ publish() {}, sync() {} }, tab, { dialog: "d", accept: true }, async (value: any) => { values.push(value); });
  await Promise.all([...(tab.stillJobs ?? [])].map((entry: any) => entry.promise));
  expect(result.status).toBe("ok");
  expect(result.still_pending).toEqual({ id: "original-act", session: "s" });
  expect(result.steps.every((step: any) => step.status === "completed" && !step.still)).toBe(true);
  expect(values).toHaveLength(1);
  expect(values[0].step).toBe(1);
  expect(values[0].still.base64).toBe(Buffer.from("image").toString("base64"));
});
