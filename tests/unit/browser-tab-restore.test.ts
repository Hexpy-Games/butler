// test-category: race
import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTabRestore } from "../../packages/butler-app/client/electron/browser/restore.mjs";

test("restore is read-only until a change, and flush preserves latest ordering across overlapping writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-restore-"));
  let urls = ["https://example.com/first"];
  const restore = createTabRestore(directory, () => urls);
  try {
    expect(await restore.read()).toEqual([]);
    await restore.flush(); expect(await readdir(directory)).toEqual([]);
    restore.changed(); const first = restore.flush();
    urls = ["https://example.com/second", "https://example.com/first", ""];
    restore.changed(); await restore.flush(); await first;
    expect(JSON.parse(await readFile(join(directory, "browser-tabs.json"), "utf8"))).toEqual(urls);
    expect(await restore.read()).toEqual(urls);
    expect(await readdir(directory)).toEqual(["browser-tabs.json"]);
  } finally { await restore.flush(); await rm(directory, { recursive: true, force: true }); }
});

test("corrupt restore and privileged saved URLs never launch a privileged page", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-restore-"));
  const restore = createTabRestore(directory, () => []);
  try {
    await writeFile(join(directory, "browser-tabs.json"), "{partial"); expect(await restore.read()).toEqual([]);
    await writeFile(join(directory, "browser-tabs.json"), JSON.stringify(["file:///etc/passwd", "app://butler", "", "https://example.com/"]));
    expect(await restore.read()).toEqual(["", "https://example.com/"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
