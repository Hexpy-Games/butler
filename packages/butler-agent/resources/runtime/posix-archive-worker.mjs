import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, posix } from "node:path";

const maxArchiveBytes = 2 * 1024 * 1024 * 1024;
const maxMetadataBytes = 1024 * 1024;
const maxEntries = 500_000;
const archiveInputBufferBytes = 64 * 1024;
const fileHashBufferBytes = 1024 * 1024;

if (process.platform === "win32") {
  throw new Error("POSIX bundled Agent archive worker does not support win32");
}

const [artifactPath, runtimeHome, inventoryPath, requestedMode = "extract"] =
  process.argv.slice(2);
if (!artifactPath || !runtimeHome || !inventoryPath) {
  throw new Error(
    "POSIX bundled Agent archive worker requires artifact, runtime, and inventory paths",
  );
}
if (requestedMode !== "extract" && requestedMode !== "verify") {
  throw new Error("POSIX bundled Agent archive worker mode is invalid");
}
const mode = requestedMode;
const fileHashBuffer =
  mode === "verify" ? Buffer.allocUnsafe(fileHashBufferBytes) : null;
const reservedArchivePath = normalizeArchivePath(
  posix.relative(posix.resolve(runtimeHome), posix.resolve(inventoryPath)),
);
if (!reservedArchivePath || !pathIsInside(runtimeHome, inventoryPath)) {
  throw new Error("POSIX bundled Agent archive inventory path is invalid");
}

if (mode === "extract") {
  mkdirSync(runtimeHome, { recursive: true });
} else if (!lstatSync(runtimeHome).isDirectory()) {
  throw new Error("bundled Agent runtime verification root is invalid");
}
const artifactHash = createHash("sha256");
const files = [];
const seenPaths = new Set();
let pending = Buffer.alloc(0);
let state = "header";
let current = null;
let paddingRemaining = 0;
let nextPath = null;
let nextLinkPath = null;
let archiveBytes = 0;
let entryCount = 0;
let sawEnd = false;
let hasLauncher = false;
let verifiedFiles = 0;

try {
  await consumeArchiveStream(artifactPath);
  const artifactSha256 = artifactHash.digest("hex");
  if (mode === "extract") {
    writeFileSync(
      inventoryPath,
      `${JSON.stringify(
        {
          schema: "butler.posix-agent-archive-inventory.v1",
          artifactSha256,
          files,
          hasLauncher,
          workerRssBytes: process.memoryUsage().rss,
          rawTextIncluded: false,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    await writeStdout(
      `${JSON.stringify({ ok: true, hasLauncher, files: files.length })}\n`,
    );
  } else {
    if (!hasLauncher) {
      throw new Error("bundled Agent artifact is missing bin/butler.js");
    }
    await writeStdout(
      `${JSON.stringify({
        ok: true,
        verified: true,
        artifactSha256,
        files: verifiedFiles,
      })}\n`,
    );
  }
} catch (error) {
  closeCurrentFile();
  throw error;
}

async function consumeArchiveStream(path) {
  const decompressor = new DecompressionStream("gzip");
  const writer = decompressor.writable.getWriter();
  const reader = decompressor.readable.getReader();
  const inputPromise = pumpArchiveInput(path, writer, reader);
  // The reader is the primary consumer. Mark an early input failure handled until
  // it is observed below so Bun cannot terminate on a transient rejection.
  void inputPromise.catch(() => {});

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      archiveBytes += chunk.length;
      if (archiveBytes > maxArchiveBytes) {
        throw new Error("bundled Agent artifact exceeds the extraction limit");
      }
      if (sawEnd) continue;
      pending =
        pending.length === 0
          ? chunk
          : Buffer.concat([pending, chunk], pending.length + chunk.length);
      consumePending();
    }
    await inputPromise;
    consumePending();
    if (!sawEnd || state !== "header" || current) {
      throw new Error("bundled Agent artifact is truncated");
    }
  } catch (error) {
    await Promise.allSettled([reader.cancel(error), writer.abort(error)]);
    await inputPromise.catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
}

async function pumpArchiveInput(path, writer, reader) {
  let descriptor = null;
  try {
    descriptor = openSync(path, "r");
    const input = Buffer.allocUnsafe(archiveInputBufferBytes);
    while (true) {
      const bytesRead = readSync(descriptor, input, 0, input.length, null);
      if (bytesRead === 0) break;
      const chunk = Buffer.from(input.subarray(0, bytesRead));
      artifactHash.update(chunk);
      await writer.write(chunk);
    }
    await writer.close();
  } catch (error) {
    await Promise.allSettled([reader.cancel(error), writer.abort(error)]);
    throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function writeStdout(value) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      process.stdout.off("error", finish);
      if (error) reject(error);
      else resolve();
    };
    process.stdout.once("error", finish);
    process.stdout.write(value, finish);
  });
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
  if (
    typeFlag !== "0" &&
    typeFlag !== "\0" &&
    typeFlag !== "" &&
    typeFlag !== "5" &&
    typeFlag !== "2"
  ) {
    throw new Error("bundled Agent artifact contains an unsafe entry type");
  }

  const normalized = normalizeArchivePath(nextPath ?? tarHeaderPath(header));
  const linkName =
    nextLinkPath ?? trimNull(header.subarray(157, 257).toString("utf8"));
  nextPath = null;
  nextLinkPath = null;
  if (!normalized) {
    if (typeFlag !== "5") {
      throw new Error("bundled Agent artifact contains an unsafe path");
    }
    if (mode === "verify" && !lstatSync(runtimeHome).isDirectory()) {
      throw new Error("bundled Agent runtime directory mismatch");
    }
    current = {
      kind: "directory",
      remaining: size,
      size,
      ignored: false,
      fd: null,
    };
    state = "data";
    return;
  }
  if (normalized === reservedArchivePath) {
    throw new Error("bundled Agent artifact contains a reserved inventory path");
  }
  if (seenPaths.has(normalized)) {
    throw new Error("bundled Agent artifact contains a duplicate path");
  }
  seenPaths.add(normalized);

  const target = archiveTargetPath(runtimeHome, normalized);
  assertSafeExtractionTarget(runtimeHome, target);
  const ignored = isManagedRuntimeArchivePath(normalized);
  if (typeFlag === "5") {
    if (mode === "extract") {
      mkdirSync(target, { recursive: true });
    } else if (!ignored && !lstatSync(target).isDirectory()) {
      throw new Error("bundled Agent runtime directory mismatch");
    }
    current = {
      kind: "directory",
      target,
      ignored,
      remaining: size,
      size,
      fd: null,
    };
  } else if (typeFlag === "2") {
    if (mode === "extract") {
      mkdirSync(dirname(target), { recursive: true });
      assertSafeExtractionTarget(runtimeHome, target);
    }
    current = {
      kind: "symlink",
      target,
      linkName: safeArchiveSymlinkTarget(runtimeHome, target, linkName),
      ignored,
      remaining: size,
      size,
      fd: null,
    };
  } else {
    let descriptor = null;
    if (mode === "extract") {
      mkdirSync(dirname(target), { recursive: true });
      assertSafeExtractionTarget(runtimeHome, target);
      descriptor = openSync(
        target,
        "wx",
        parseOctal(header.subarray(100, 108)) || 0o644,
      );
    }
    current = {
      kind: "file",
      path: normalized,
      target,
      ignored,
      remaining: size,
      size,
      hash: createHash("sha256"),
      fd: descriptor,
    };
  }
  state = "data";
}

function consumeEntryData(data) {
  if (current.kind === "file") {
    if (current.fd !== null) {
      let offset = 0;
      while (offset < data.length) {
        offset += writeSync(current.fd, data, offset, data.length - offset);
      }
    }
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
    if (finished.fd !== null) {
      closeSync(finished.fd);
      finished.fd = null;
    }
    const sha256 = finished.hash.digest("hex");
    if (mode === "extract") {
      files.push({
        path: finished.path,
        size: finished.size,
        sha256,
      });
    } else if (!finished.ignored) {
      verifyInstalledFile(finished.target, finished.size, sha256);
      verifiedFiles += 1;
    }
    if (finished.path === "bin/butler.js") hasLauncher = true;
  } else if (finished.kind === "symlink") {
    if (mode === "extract") {
      symlinkSync(finished.linkName, finished.target);
    } else if (!finished.ignored) {
      verifyInstalledSymlink(finished.target, finished.linkName);
    }
  } else if (finished.kind === "L") {
    nextPath = trimNull(Buffer.concat(finished.data).toString("utf8"));
  } else if (finished.kind === "x") {
    const pax = parsePax(Buffer.concat(finished.data));
    if (typeof pax.path === "string") nextPath = pax.path;
    if (typeof pax.linkpath === "string") nextLinkPath = pax.linkpath;
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

function verifyInstalledFile(target, expectedSize, expectedSha256) {
  const file = lstatSync(target);
  if (!file.isFile() || file.size !== expectedSize) {
    throw new Error("bundled Agent runtime file mismatch");
  }
  if (sha256File(target) !== expectedSha256) {
    throw new Error("bundled Agent runtime file digest mismatch");
  }
}

function verifyInstalledSymlink(target, expectedLinkName) {
  if (!lstatSync(target).isSymbolicLink()) {
    throw new Error("bundled Agent runtime symlink mismatch");
  }
  if (readlinkSync(target) !== expectedLinkName) {
    throw new Error("bundled Agent runtime symlink target mismatch");
  }
}

function sha256File(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  try {
    let bytesRead;
    do {
      bytesRead = readSync(
        descriptor,
        fileHashBuffer,
        0,
        fileHashBuffer.length,
        null,
      );
      if (bytesRead > 0) {
        hash.update(fileHashBuffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function isManagedRuntimeArchivePath(entryName) {
  return (
    entryName === "packages/butler-agent/resources/runtime" ||
    entryName.startsWith("packages/butler-agent/resources/runtime/")
  );
}

function normalizeArchivePath(entryName) {
  const raw = String(entryName ?? "");
  if (!raw || raw.includes("\0") || raw.includes("\\")) {
    throw new Error("bundled Agent artifact contains an unsafe path");
  }
  const normalized = raw.replace(/^\.\/+/u, "").replace(/\/+$/u, "");
  if (!normalized) return "";
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    /^[A-Za-z]:/u.test(normalized)
  ) {
    throw new Error("bundled Agent artifact contains an unsafe path");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "..")) {
    throw new Error("bundled Agent artifact contains an unsafe path");
  }
  return segments.filter((segment) => segment !== ".").join("/");
}

function archiveTargetPath(root, entryName) {
  const target = posix.resolve(root, ...entryName.split("/"));
  if (!pathIsInside(root, target)) {
    throw new Error("bundled Agent artifact contains an unsafe path");
  }
  return target;
}

function assertSafeExtractionTarget(root, target) {
  if (!pathIsInside(root, target)) {
    throw new Error("bundled Agent artifact contains an unsafe path");
  }
  const resolvedRoot = posix.resolve(root);
  let canonicalRoot = resolvedRoot;
  try {
    canonicalRoot = realpathSync(resolvedRoot);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let cursor = posix.dirname(target);
  while (pathIsInside(resolvedRoot, cursor)) {
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new Error("bundled Agent artifact target crosses a reparse point");
      }
      const actual = realpathSync(cursor);
      if (!pathIsInside(canonicalRoot, actual)) {
        throw new Error(
          "bundled Agent artifact target escapes through a reparse point",
        );
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (cursor === resolvedRoot) break;
    const parent = posix.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function safeArchiveSymlinkTarget(root, target, linkName) {
  const linkTarget = String(linkName ?? "");
  if (!linkTarget || linkTarget.startsWith("/") || linkTarget.includes("\0")) {
    throw new Error("bundled Agent artifact contains an unsafe symlink");
  }
  const resolvedTarget = posix.resolve(posix.dirname(target), linkTarget);
  if (!pathIsInside(root, resolvedTarget)) {
    throw new Error("bundled Agent artifact contains an unsafe symlink");
  }
  return linkTarget;
}

function pathIsInside(root, candidate) {
  const resolvedRoot = posix.resolve(root).replace(/\/+$/u, "");
  const resolvedCandidate = posix.resolve(candidate).replace(/\/+$/u, "");
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${posix.sep}`)
  );
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
    const length = Number.parseInt(
      data.subarray(cursor, separator).toString("ascii"),
      10,
    );
    if (!Number.isFinite(length) || length <= 0 || cursor + length > data.length) {
      break;
    }
    const record = data
      .subarray(separator + 1, cursor + length - 1)
      .toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) result[record.slice(0, equals)] = record.slice(equals + 1);
    cursor += length;
  }
  return result;
}

function trimNull(value) {
  return value.replace(/\0.*$/su, "").trim();
}
