import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { apiErrorCode } from "../../packages/butler-app/client/ui/src/app/api.ts";

function withBridge<T>(bridge: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.window;
  Object.assign(globalThis, { window: { location: { origin: "http://localhost" }, butlerApp: bridge } });
  return run().finally(() => Object.assign(globalThis, { window: previous }));
}

// test-category: pure-logic
test("canon upload preserves bounded desktop error codes and file metadata", async () => {
  const { uploadCanonFile } = await import("../../packages/butler-app/client/ui/src/app/canonApi.ts");
  const file = new File(["notes"], "notes.txt", { type: "text/plain" });
  for (const [code, status] of [["file_too_large", 413], ["too_many_attachments", 409]] as const) {
    const refused = async () => ({ ok: false, error: { schema: "butler.app.bridge-error.v1", code, status } });
    const error = await withBridge({ uploadCanonFile: refused }, () => uploadCanonFile("project", file).catch((error: unknown) => error));
    expect(apiErrorCode(error)).toBe(code);
    expect((error as { status: number }).status).toBe(status);
  }
  const stored = { file_id: "file-id", width: 31, height: 17, kind: "image" as const,
    mime_type: "image/png", safe_name: "image.png", size_bytes: 1, sha256: "hash",
    url: "/message-files/file-id", created_at: "now" };
  const result = await withBridge({ uploadCanonFile: async () => ({ ok: true, data: { file: stored } }) }, () => uploadCanonFile("project", file));
  expect(result).toEqual(stored);
});

// test-category: security
test("actual canon preload returns a bounded upload failure envelope", () => {
  const preloadPath = resolve(import.meta.dir, "../../packages/butler-app/client/electron/preload.cjs");
  const result = spawnSync("node", ["-e", `
    const Module = require("node:module"); const load = Module._load; let bridge;
    Module._load = (request, parent, main) => request === "electron" ? {
      contextBridge: { exposeInMainWorld(name, value) { if (name === "butlerApp") bridge = value; } },
      ipcRenderer: { invoke: async channel => channel === "butler:get-local-auth-headers" ? {} : null, on() {}, send() {}, removeListener() {} }
    } : load(request, parent, main);
    global.fetch = async () => ({ ok: false, status: 413, json: async () => ({error:{code:"file_too_large",message:"private detail"}}) });
    require(${JSON.stringify(preloadPath)});
    bridge.uploadCanonFile({projectId:"project",name:"note.txt",mimeType:"text/plain",bytes:new ArrayBuffer(1)})
      .then(result => process.stdout.write(JSON.stringify(result))).catch(() => process.exitCode = 1);
  `], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: false, error: { schema: "butler.app.bridge-error.v1", code: "file_too_large", status: 413 } });
});
