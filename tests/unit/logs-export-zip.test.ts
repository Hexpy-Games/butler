// test-category: format-pin
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { appendZipEntry } from "../../packages/butler-app/client/electron/logs-export.mjs";

/** The entries of a zip as its central directory lists them, each checked against its local header. */
function entries(zip: Buffer): Array<{ name: string; data: string }> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  expect(at + zip.readUInt32LE(end + 12)).toBe(end);
  const found = [];
  for (let index = 0; index < count; index += 1) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(dataStart, dataStart + size);
    expect(crc32(data) >>> 0).toBe(zip.readUInt32LE(at + 16));
    found.push({ name, data: data.toString("utf8") });
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return found;
}

test("export zips gain the UI crash entry after their existing entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "butler-logs-zip-"));
  try {
    const path = join(dir, "logs.zip");
    const empty = Buffer.alloc(22);
    empty.writeUInt32LE(0x06054b50, 0);
    writeFileSync(path, empty);
    expect(await appendZipEntry(path, "agent/main.jsonl", Buffer.from("{\"msg\":\"one\"}\n"))).toBe(true);
    expect(await appendZipEntry(path, "app/ui-crashes.json", Buffer.from("[{\"message\":\"한글\"}]"))).toBe(true);
    expect(entries(readFileSync(path))).toEqual([
      { name: "agent/main.jsonl", data: "{\"msg\":\"one\"}\n" },
      { name: "app/ui-crashes.json", data: "[{\"message\":\"한글\"}]" },
    ]);
    writeFileSync(path, "not a zip");
    expect(await appendZipEntry(path, "app/ui-crashes.json", Buffer.from("[]"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
