import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, win32 } from "node:path";
import { createGunzip } from "node:zlib";

const maxArchiveBytes = 2 * 1024 * 1024 * 1024;
const maxMetadataBytes = 1024 * 1024;
const maxEntries = 500_000;
const windowsReservedNames =
  /^(?:aux|clock\$|com[1-9]|con|lpt[1-9]|nul|prn)(?:\..*)?$/iu;

if (process.platform !== "win32") {
  throw new Error("Windows bundled Agent archive worker requires win32");
}

const [artifactPath, runtimeHome, inventoryPath] = process.argv.slice(2);
if (!artifactPath || !runtimeHome || !inventoryPath) {
  throw new Error("Windows bundled Agent archive worker requires artifact, runtime, and inventory paths");
}

mkdirSync(runtimeHome, { recursive: true });
const artifactHash = createHash("sha256");
const source = createReadStream(artifactPath);
source.on("data", (chunk) => artifactHash.update(chunk));
const gunzip = source.pipe(createGunzip());
const entries = [];
const seenPaths = new Set();
let pending = Buffer.alloc(0);
let state = "header";
let current = null;
let paddingRemaining = 0;
let nextPath = null;
let archiveBytes = 0;
let entryCount = 0;
let sawEnd = false;

try {
  for await (const chunk of gunzip) {
    archiveBytes += chunk.length;
    if (archiveBytes > maxArchiveBytes) {
      throw new Error("bundled Agent artifact exceeds the extraction limit");
    }
    if (sawEnd) continue;
    pending = pending.length === 0
      ? chunk
      : Buffer.concat([pending, chunk], pending.length + chunk.length);
    consumePending();
  }
  consumePending();
  if (!sawEnd || state !== "header" || current) {
    throw new Error("bundled Agent artifact is truncated");
  }
  const hasLauncher = entries.some((entry) => entry.path === "bin/butler.js");
  writeFileSync(
    inventoryPath,
    `${JSON.stringify({
      schema: "butler.windows-agent-archive-inventory.v1",
      artifactSha256: artifactHash.digest("hex"),
      files: entries,
      hasLauncher,
      workerRssBytes: process.memoryUsage().rss,
      rawTextIncluded: false,
    }, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify({ ok: true, hasLauncher, files: entries.length })}\n`);
} catch (error) {
  closeCurrentFile();
  throw error;
}

function consumePending() {
  while (pending.length > 0 && !sawEnd) {
    if (state === "header") {
      if (pending.length < 512) return;
      const header = pending.subarray(0, 512);
      pending = pending.subarray(512);
      if (header.every((byte) => byte === 0)) {
        sawEnd = true;
        pending = Buffer.alloc(0);
        return;
      }
      assertTarChecksum(header);
      beginEntry(header);
      if (current.remaining === 0) finishEntry();
      continue;
    }
    if (state === "data") {
      if (pending.length === 0) return;
      const length = Math.min(current.remaining, pending.length);
      const data = pending.subarray(0, length);
      pending = pending.subarray(length);
      consumeEntryData(data);
      current.remaining -= length;
      if (current.remaining === 0) finishEntry();
      continue;
    }
    if (state === "padding") {
      const length = Math.min(paddingRemaining, pending.length);
      pending = pending.subarray(length);
      paddingRemaining -= length;
      if (paddingRemaining === 0) state = "header";
    }
  }
}

function beginEntry(header) {
  entryCount += 1;
  if (entryCount > maxEntries) {
    throw new Error("bundled Agent artifact contains too many files");
  }
  const size = parseOctal(header.subarray(124, 136));
  if (!Number.isSafeInteger(size) || size < 0 || size > maxArchiveBytes) {
    throw new Error("bundled Agent artifact contains an invalid file size");
  }
  const typeFlag = String.fromCharCode(header[156] || 0);
  const headerName = tarHeaderPath(header);
  if (typeFlag === "L" || typeFlag === "x" || typeFlag === "g") {
    if (size > maxMetadataBytes) {
      throw new Error("bundled Agent artifact metadata is too large");
    }
    current = {
      kind: typeFlag,
      remaining: size,
      size,
      data: [],
      fd: null,
    };
    state = "data";
    return;
  }
  if (typeFlag !== "0" && typeFlag !== "\0" && typeFlag !== "" && typeFlag !== "5") {
    throw new Error("bundled Agent Windows artifact must contain only files and directories");
  }
  const normalized = normalizeWindowsArchivePath(nextPath ?? headerName);
  nextPath = null;
  if (!normalized) {
    if (typeFlag !== "5") {
      throw new Error("bundled Agent artifact contains an unsafe path");
    }
    current = { kind: "directory", remaining: size, size, data: [], fd: null };
    state = "data";
    return;
  }
  if (seenPaths.has(normalized)) {
    throw new Error("bundled Agent artifact contains a duplicate path");
  }
  seenPaths.add(normalized);
  const target = windowsArchiveTarget(runtimeHome, normalized);
  assertNoReparseParent(runtimeHome, target);
  if (typeFlag === "5") {
    mkdirSync(target, { recursive: true });
    current = { kind: "directory", remaining: size, size, data: [], fd: null };
  } else {
    mkdirSync(dirname(target), { recursive: true });
    assertNoReparseParent(runtimeHome, target);
    const fd = openSync(target, "wx", parseOctal(header.subarray(100, 108)) || 0o644);
    current = {
      kind: "file",
      path: normalized,
      remaining: size,
      size,
      hash: createHash("sha256"),
      fd,
      data: [],
    };
  }
  state = "data";
}

function consumeEntryData(data) {
  if (current.kind === "file") {
    writeSync(current.fd, data);
    current.hash.update(data);
    return;
  }
  if (current.kind === "L" || current.kind === "x" || current.kind === "g") {
    current.data.push(Buffer.from(data));
  }
}

function finishEntry() {
  const finished = current;
  current = null;
  if (finished.kind === "file") {
    closeSync(finished.fd);
    finished.fd = null;
    entries.push({
      path: finished.path,
      size: finished.size,
      sha256: finished.hash.digest("hex"),
    });
  } else if (finished.kind === "L") {
    nextPath = trimNull(Buffer.concat(finished.data).toString("utf8"));
  } else if (finished.kind === "x") {
    const pax = parsePax(Buffer.concat(finished.data));
    if (typeof pax.path === "string") nextPath = pax.path;
    if (typeof pax.linkpath === "string") {
      throw new Error("bundled Agent Windows artifact must not contain links");
    }
  }
  paddingRemaining = (512 - (finished.size % 512)) % 512;
  state = paddingRemaining === 0 ? "header" : "padding";
}

function closeCurrentFile() {
  if (current?.fd === null || current?.fd === undefined) return;
  try {
    closeSync(current.fd);
  } catch {
    // Preserve the primary extraction failure.
  }
  current.fd = null;
}

function normalizeWindowsArchivePath(entryName) {
  const raw = String(entryName ?? "");
  if (!raw || raw.includes("\0") || raw.includes("\\")) {
    throw new Error("bundled Agent artifact contains an unsafe path");
  }
  const normalized = raw.replace(/^\.\/+/u, "").replace(/\/+$/u, "");
  if (!normalized || normalized === ".") return "";
  if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    throw new Error("bundled Agent artifact contains an unsafe path");
  }
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes(":") ||
        /[. ]$/u.test(segment) ||
        windowsReservedNames.test(segment),
    )
  ) {
    throw new Error("bundled Agent artifact contains an unsafe Windows path");
  }
  return segments.join("/");
}

function windowsArchiveTarget(root, normalized) {
  const resolvedRoot = win32.resolve(root);
  const target = win32.resolve(root, ...normalized.split("/"));
  const comparableRoot = resolvedRoot.toLocaleLowerCase("en-US");
  const comparableTarget = target.toLocaleLowerCase("en-US");
  if (
    comparableTarget !== comparableRoot &&
    !comparableTarget.startsWith(`${comparableRoot}${win32.sep}`)
  ) {
    throw new Error("bundled Agent artifact contains an unsafe path");
  }
  return target;
}

function assertNoReparseParent(root, target) {
  const resolvedRoot = win32.resolve(root);
  let cursor = dirname(target);
  while (cursor.toLocaleLowerCase("en-US") !== resolvedRoot.toLocaleLowerCase("en-US")) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error("bundled Agent artifact target crosses a reparse point");
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Error("bundled Agent artifact target escapes its root");
    }
    cursor = parent;
  }
}

function assertTarChecksum(header) {
  const expected = parseOctal(header.subarray(148, 156));
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (expected !== actual) {
    throw new Error("bundled Agent artifact contains an invalid tar header");
  }
}

function tarHeaderPath(header) {
  const name = trimNull(header.subarray(0, 100).toString("utf8"));
  const prefix = trimNull(header.subarray(345, 500).toString("utf8"));
  return prefix ? `${prefix}/${name}` : name;
}

function parseOctal(bytes) {
  const text = trimNull(bytes.toString("utf8")).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function parsePax(data) {
  const result = {};
  let cursor = 0;
  while (cursor < data.length) {
    const separator = data.indexOf(0x20, cursor);
    if (separator < 0) break;
    const length = Number.parseInt(data.subarray(cursor, separator).toString("ascii"), 10);
    if (!Number.isFinite(length) || length <= 0 || cursor + length > data.length) break;
    const record = data.subarray(separator + 1, cursor + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) result[record.slice(0, equals)] = record.slice(equals + 1);
    cursor += length;
  }
  return result;
}

function trimNull(value) {
  return value.replace(/\0.*$/su, "").trim();
}
