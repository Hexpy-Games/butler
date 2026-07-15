import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  archiveTargetPath,
  managedRuntimeExecutablePath,
  pathIsInside,
  removeStaleRuntimeSiblingsSync,
  renameWithRetrySync,
  safeArchiveSymlinkTarget,
} from "../../client/electron/runtime-filesystem.mjs";

if (process.platform !== "win32") {
  throw new Error("runtime filesystem smoke must run on Windows");
}

const root = join(tmpdir(), "Butler Windows 경로 smoke");
rmSync(root, { recursive: true, force: true });

try {
  const runtimeHome = join(root, "versions", "1.2.3");
  const backupHome = `${runtimeHome}.previous-crash`;
  mkdirSync(backupHome, { recursive: true });
  writeFileSync(join(backupHome, "복구 marker.txt"), "recovered\n");
  const parent = dirname(runtimeHome);
  const entries = readdirSync(parent).map((name) => ({
    name,
    mtimeMs: statSync(join(parent, name)).mtimeMs,
  }));
  const recovery = removeStaleRuntimeSiblingsSync(runtimeHome, { entries });

  const source = join(root, "rename source 한글.txt");
  const target = join(root, "rename target 한글.txt");
  writeFileSync(source, "renamed\n");
  renameWithRetrySync(source, target);

  const longDirectory = join(
    root,
    ...Array.from({ length: 24 }, (_, index) => `segment-${index}`),
  );
  mkdirSync(longDirectory, { recursive: true });
  const longFile = join(longDirectory, "long path 한글.txt");
  writeFileSync(longFile, "long-path\n");

  let windowsLinksRejected = false;
  try {
    safeArchiveSymlinkTarget(root, join(root, "link"), "target", "win32");
  } catch {
    windowsLinksRejected = true;
  }

  const executable = managedRuntimeExecutablePath(runtimeHome);
  const archiveTarget = archiveTargetPath(root, "payload/한글 file.txt");
  const result = {
    ok:
      recovery.recoveredBackup === "1.2.3.previous-crash" &&
      readFileSync(join(runtimeHome, "복구 marker.txt"), "utf8") ===
        "recovered\n" &&
      readFileSync(target, "utf8") === "renamed\n" &&
      readFileSync(longFile, "utf8") === "long-path\n" &&
      executable.endsWith("\\runtime\\bin\\bun.exe") &&
      archiveTarget.endsWith("\\payload\\한글 file.txt") &&
      pathIsInside(
        root.toLocaleUpperCase("en-US"),
        target.toLocaleLowerCase("en-US"),
      ) &&
      windowsLinksRejected,
    platform: process.platform,
    unicodeAndSpaces: true,
    longPathLength: longFile.length,
    longPathWritten: existsSync(longFile),
    caseInsensitiveContainment: pathIsInside(
      root.toLocaleUpperCase("en-US"),
      target.toLocaleLowerCase("en-US"),
    ),
    crashBackupRecovered: recovery.recoveredBackup !== null,
    atomicRename: existsSync(target) && !existsSync(source),
    windowsLinksRejected,
    runtimeExecutable: executable.slice(-11),
    rawTextIncluded: false,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
