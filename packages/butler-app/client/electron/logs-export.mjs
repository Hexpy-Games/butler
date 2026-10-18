// Settings > Logs export: the agent's zip, saved where the user picks, with the
// app's UI crash records added as one more entry.
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_BYTES = 22;
const MAX_COMMENT = 0xffff;

/**
 * Appends one stored (uncompressed) entry to the zip at `path` in place: the new
 * local header and data overwrite the old central directory, which is written
 * again after them with the new entry and a new end record. Reads only the end
 * record and the central directory. Returns false for zip64 or damaged archives.
 */
export async function appendZipEntry(path, name, data) {
  const file = await open(path, "r+");
  try {
    const { size } = await file.stat();
    const tailLength = Math.min(size, EOCD_BYTES + MAX_COMMENT);
    const tail = Buffer.alloc(tailLength);
    await file.read(tail, 0, tailLength, size - tailLength);
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0 || tail.readUInt32LE(end) !== EOCD_SIGNATURE) return false;
    const entries = tail.readUInt16LE(end + 10);
    const directoryBytes = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    if (entries === 0xffff || directoryOffset === 0xffffffff || directoryOffset + directoryBytes > size) return false;
    const directory = Buffer.alloc(directoryBytes);
    await file.read(directory, 0, directoryBytes, directoryOffset);
    const fileName = Buffer.from(name, "utf8");
    const checksum = crc32(data);
    const local = header(0x04034b50, fileName, data.length, checksum, null);
    const central = header(0x02014b50, fileName, data.length, checksum, directoryOffset);
    const newDirectoryOffset = directoryOffset + local.length + data.length;
    const record = Buffer.alloc(EOCD_BYTES);
    record.writeUInt32LE(EOCD_SIGNATURE, 0);
    record.writeUInt16LE(entries + 1, 8);
    record.writeUInt16LE(entries + 1, 10);
    record.writeUInt32LE(directoryBytes + central.length, 12);
    record.writeUInt32LE(newDirectoryOffset, 16);
    const output = Buffer.concat([local, data, directory, central, record]);
    await file.write(output, 0, output.length, directoryOffset);
    await file.truncate(directoryOffset + output.length);
    return true;
  } finally {
    await file.close();
  }
}

/** A local (offset null) or central directory header for a stored UTF-8 entry. */
function header(signature, fileName, length, checksum, offset) {
  const central = offset !== null;
  const fixed = central ? 46 : 30;
  const bytes = Buffer.alloc(fixed + fileName.length);
  bytes.writeUInt32LE(signature, 0);
  let at = 4;
  if (central) { bytes.writeUInt16LE(20, at); at += 2; }
  bytes.writeUInt16LE(20, at); // version needed
  bytes.writeUInt16LE(0x0800, at + 2); // UTF-8 name
  bytes.writeUInt16LE(0, at + 4); // stored
  bytes.writeUInt16LE(0, at + 6); // time
  bytes.writeUInt16LE(0x21, at + 8); // date: 1980-01-01
  bytes.writeUInt32LE(checksum >>> 0, at + 10);
  bytes.writeUInt32LE(length, at + 14);
  bytes.writeUInt32LE(length, at + 18);
  bytes.writeUInt16LE(fileName.length, at + 22);
  if (central) bytes.writeUInt32LE(offset, 42);
  fileName.copy(bytes, fixed);
  return bytes;
}

/** Registers `butler:export-logs`; every dependency is injected by main. */
export function registerLogsExport({ ipcMain, dialog, serverFetch, readUiCrashes, isTrustedSender, saveLabel }) {
  ipcMain.handle("butler:export-logs", async (event, input = {}) => {
    if (!isTrustedSender(event)) throw new Error("invalid_logs_export_sender");
    const since = typeof input?.since === "string" && input.since.length <= 64 ? input.since : undefined;
    const includeBodies = input?.includeBodies === true;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/gu, "-");
    const result = await dialog.showSaveDialog({ defaultPath: `butler-logs-${stamp}.zip`, buttonLabel: await saveLabel() });
    if (result.canceled || !result.filePath) return { saved: false };
    const response = await serverFetch("/logs/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(since ? { since } : {}), include_bodies: includeBodies }),
    });
    if (!response.ok || !response.body) throw new Error(`Log export failed with status ${response.status}.`);
    await writeExport(result.filePath, response.body, await readUiCrashes());
    return { saved: true };
  });
}

/** Writes beside the destination and renames on success, so a failed export leaves no partial zip. */
async function writeExport(destination, body, crashes) {
  const partial = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.partial`);
  try {
    await pipeline(Readable.fromWeb(body), createWriteStream(partial, { mode: 0o600 }));
    if (Array.isArray(crashes) && crashes.length > 0) {
      await appendZipEntry(partial, "app/ui-crashes.json", Buffer.from(JSON.stringify(crashes, null, 2)));
    }
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}
