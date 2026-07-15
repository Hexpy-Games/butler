import {
  existsSync,
  lstatSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { posix, win32 } from "node:path";

const windowsRetryableErrors = new Set(["EACCES", "EBUSY", "EEXIST", "EPERM"]);
const windowsReservedNames =
  /^(?:aux|clock\$|com[1-9]|con|lpt[1-9]|nul|prn)(?:\..*)?$/iu;

export function managedRuntimeExecutablePath(
  runtimeHome,
  platform = process.platform,
) {
  return platform === "win32"
    ? win32.join(
        runtimeHome,
        "packages",
        "butler-agent",
        "resources",
        "runtime",
        "bin",
        "bun.exe",
      )
    : posix.join(
        runtimeHome,
        "packages",
        "butler-agent",
        "resources",
        "runtime",
        "bin",
        "bun",
      );
}

export function managedRuntimeSourceExecutablePath(
  resourceRoot,
  platform = process.platform,
) {
  return platform === "win32"
    ? win32.join(resourceRoot, "runtime", "bin", "bun.exe")
    : posix.join(resourceRoot, "runtime", "bin", "bun");
}

export function normalizeArchivePath(entryName, platform = process.platform) {
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
  if (
    platform === "win32" &&
    segments.some(
      (segment) =>
        segment.includes(":") ||
        /[. ]$/u.test(segment) ||
        windowsReservedNames.test(segment),
    )
  ) {
    throw new Error("bundled Agent artifact contains an unsafe Windows path");
  }
  return segments.filter((segment) => segment !== ".").join("/");
}

export function archiveTargetPath(
  root,
  entryName,
  platform = process.platform,
) {
  const normalized = normalizeArchivePath(entryName, platform);
  const pathApi = platform === "win32" ? win32 : posix;
  const target = pathApi.resolve(root, ...normalized.split("/"));
  if (!pathIsInside(root, target, platform)) {
    throw new Error("bundled Agent artifact contains an unsafe path");
  }
  return target;
}

export function pathIsInside(root, candidate, platform = process.platform) {
  const pathApi = platform === "win32" ? win32 : posix;
  const resolvedRoot = comparablePath(pathApi.resolve(root), platform);
  const resolvedCandidate = comparablePath(
    pathApi.resolve(candidate),
    platform,
  );
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${pathApi.sep}`)
  );
}

export function assertSafeExtractionTarget(
  root,
  target,
  {
    platform = process.platform,
    lstat = lstatSync,
    realpath = realpathSync,
  } = {},
) {
  if (!pathIsInside(root, target, platform)) {
    throw new Error("bundled Agent artifact contains an unsafe path");
  }
  const pathApi = platform === "win32" ? win32 : posix;
  const resolvedRoot = pathApi.resolve(root);
  let canonicalRoot = resolvedRoot;
  try {
    canonicalRoot = realpath(resolvedRoot);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let cursor = pathApi.dirname(target);
  while (pathIsInside(resolvedRoot, cursor, platform)) {
    try {
      if (lstat(cursor).isSymbolicLink()) {
        throw new Error(
          "bundled Agent artifact target crosses a reparse point",
        );
      }
      const actual = realpath(cursor);
      if (!pathIsInside(canonicalRoot, actual, platform)) {
        throw new Error(
          "bundled Agent artifact target escapes through a reparse point",
        );
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (
      comparablePath(cursor, platform) ===
      comparablePath(resolvedRoot, platform)
    )
      break;
    const parent = pathApi.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

export function safeArchiveSymlinkTarget(
  root,
  target,
  linkName,
  platform = process.platform,
) {
  if (platform === "win32") {
    throw new Error("bundled Agent Windows artifact must not contain links");
  }
  const linkTarget = String(linkName ?? "");
  if (!linkTarget || linkTarget.startsWith("/") || linkTarget.includes("\0")) {
    throw new Error("bundled Agent artifact contains an unsafe symlink");
  }
  const resolvedTarget = posix.resolve(posix.dirname(target), linkTarget);
  if (!pathIsInside(root, resolvedTarget, platform)) {
    throw new Error("bundled Agent artifact contains an unsafe symlink");
  }
  return linkTarget;
}

export function renameWithRetrySync(
  source,
  target,
  {
    platform = process.platform,
    attempts = 8,
    rename = renameSync,
    delay = synchronousDelay,
  } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      if (
        platform !== "win32" ||
        !windowsRetryableErrors.has(error?.code) ||
        attempt === attempts
      ) {
        throw error;
      }
      delay(Math.min(25 * 2 ** (attempt - 1), 400));
    }
  }
  throw lastError;
}

export function removeStaleRuntimeSiblingsSync(
  runtimeHome,
  {
    platform = process.platform,
    entries,
    now = Date.now(),
    maxAgeMs = 24 * 60 * 60 * 1000,
    remove = rmSync,
    exists = existsSync,
    rename = renameSync,
  },
) {
  const pathApi = platform === "win32" ? win32 : posix;
  const base = pathApi.basename(runtimeHome);
  const runtimeParent = pathApi.dirname(runtimeHome);
  const backups = entries
    .filter((entry) => entry.name.startsWith(`${base}.previous-`))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  let recoveredBackup = null;
  if (!exists(runtimeHome) && backups.length > 0) {
    recoveredBackup = backups[0].name;
    renameWithRetrySync(
      pathApi.join(runtimeParent, recoveredBackup),
      runtimeHome,
      {
        platform,
        rename,
      },
    );
  }
  for (const entry of entries) {
    if (
      entry.name !== recoveredBackup &&
      (entry.name.startsWith(`${base}.staging-`) ||
        entry.name.startsWith(`${base}.previous-`)) &&
      now - entry.mtimeMs >= maxAgeMs
    ) {
      remove(pathApi.join(runtimeParent, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }
  return { recoveredBackup };
}

function comparablePath(value, platform) {
  const normalized = value.replace(/[\\/]+$/u, "");
  return platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function synchronousDelay(milliseconds) {
  const state = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(state, 0, 0, milliseconds);
}
