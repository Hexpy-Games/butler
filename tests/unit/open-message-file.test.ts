// test-category: security
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOpenMessageFile } from "../../packages/butler-app/client/electron/open-message-file.mjs";

const fileId = "file-12345678-1234-1234-1234-123456789abc";
type Handler = Parameters<Parameters<typeof registerOpenMessageFile>[0]["ipcMain"]["handle"]>[1];
let dir: string, root: string, file: string;
let handler: Handler;
let response: { data?: { path: string; open: boolean }; error?: { code: string } };
let trusted: boolean, failure: string;
let calls: Array<[string, string]>;
let requests: Array<{ url: string; body: unknown }>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-message-file-"));
  root = join(dir, "opened-files");
  await mkdir(root);
  file = join(root, "copy.txt");
  await writeFile(file, "stored bytes");
  response = { data: { path: file, open: true } };
  trusted = true;
  failure = "";
  calls = [];
  requests = [];
  registerOpenMessageFile({
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    serverFetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: !response.error, json: async () => response };
    },
    openedFilesRoot: root,
    isTrustedSender: () => trusted,
    openPath: async (path) => { calls.push(["open", path]); return failure; },
    showItemInFolder: (path) => { calls.push(["reveal", path]); },
  });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test("untrusted sender throws before fetching", async () => {
  trusted = false;
  await expect(handler({}, { fileId })).rejects.toThrow("invalid_open_file_sender");
  expect(requests).toEqual([]);
  expect(calls).toEqual([]);
});
test("invalid id throws before fetching", async () => {
  await expect(handler({}, { fileId: "../copy" })).rejects.toThrow("Invalid Butler file.");
  expect(requests).toEqual([]);
});
test("only the id reaches the gateway; verified open uses the real path", async () => {
  expect(await handler({}, { fileId, path: join(dir, "untrusted"), reveal: false })).toEqual({ opened: true });
  expect(requests).toEqual([{ url: "/internal/opened-files", body: { file_id: fileId } }]);
  expect(calls).toEqual([["open", await realpath(file)]]);
});
test("outside path is refused without shell calls", async () => {
  const outside = join(dir, "outside.txt");
  await writeFile(outside, "outside");
  response.data!.path = outside;
  expect(await handler({}, { fileId })).toEqual({ opened: false, code: "open_path_refused" });
  expect(calls).toEqual([]);
});
test("symlink pointing outside is refused without shell calls", async () => {
  const outside = join(dir, "outside.txt");
  await writeFile(outside, "outside");
  const link = join(root, "link.txt");
  await symlink(outside, link);
  response.data!.path = link;
  expect(await handler({}, { fileId })).toEqual({ opened: false, code: "open_path_refused" });
  expect(calls).toEqual([]);
});
test("the root itself is refused without shell calls", async () => {
  response.data!.path = root;
  expect(await handler({}, { fileId })).toEqual({ opened: false, code: "open_path_refused" });
  expect(calls).toEqual([]);
});
test("gateway reveal cannot be upgraded by the renderer", async () => {
  response.data!.open = false;
  expect(await handler({}, { fileId, reveal: false })).toEqual({ opened: true, revealed: true });
  expect(calls).toEqual([["reveal", await realpath(file)]]);
});
test("renderer can downgrade open to reveal", async () => {
  expect(await handler({}, { fileId, reveal: true })).toEqual({ opened: true, revealed: true });
  expect(calls).toEqual([["reveal", await realpath(file)]]);
});
test("gateway error code passes through without shell calls", async () => {
  response = { error: { code: "not_found" } };
  expect(await handler({}, { fileId })).toEqual({ opened: false, code: "not_found" });
  expect(calls).toEqual([]);
});
test("shell open failure is reported", async () => {
  failure = "No application";
  expect(await handler({}, { fileId })).toEqual({ opened: false, code: "open_failed" });
});
