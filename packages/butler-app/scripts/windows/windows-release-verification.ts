import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import {
  isWindowsGuiSubsystemPe,
  isWindowsX64Pe,
  verifyWindowsAuthenticodeFiles,
} from "../release/package-app-release.ts";

export function verifySignedWindowsPayload(input: {
  expectedSignerThumbprint: string;
  packagePath: string;
  setupPath: string;
}): { required: string[]; peCount: number } {
  const extractDir = mkdtempSync(join(tmpdir(), "butler-windows-nupkg-"));
  try {
    const extraction = spawnSync(
      "tar.exe",
      ["-xf", input.packagePath, "-C", extractDir],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    if (extraction.status !== 0) {
      throw new Error("Windows release update package could not be inspected");
    }
    const files = listFiles(extractDir);
    const appExecutable = requireUniqueFile(files, "Butler.exe");
    const runtimeExecutable = requireUniqueFile(
      files,
      "bun.exe",
      "resources/bundled-agent/runtime/bin",
    );
    const processHost = requireUniqueFile(
      files,
      "butler-process-host.exe",
      "resources/bundled-agent/runtime/bin",
    );
    requireWindowsX64Pe(appExecutable, "Butler.exe");
    requireWindowsX64Pe(runtimeExecutable, "bun.exe");
    requireWindowsX64Pe(processHost, "butler-process-host.exe");
    if (!isWindowsGuiSubsystemPe(readFileSync(processHost))) {
      throw new Error(
        "Windows release butler-process-host.exe must use the GUI subsystem",
      );
    }
    const required = [
      input.setupPath,
      appExecutable,
      runtimeExecutable,
      processHost,
    ];
    const signableExtensions = new Set([
      ".dll",
      ".efi",
      ".exe",
      ".node",
      ".scr",
      ".sys",
    ]);
    const packagedPeFiles = files.filter((path) =>
      signableExtensions.has(extname(path).toLocaleLowerCase("en-US")),
    );
    if (packagedPeFiles.length < required.length - 1) {
      throw new Error("Windows release package PE inventory is incomplete");
    }
    const signedFiles = [input.setupPath, ...packagedPeFiles];
    const signatures = verifyWindowsAuthenticodeFiles(signedFiles);
    for (const signature of signatures) {
      if (signature.signerThumbprint !== input.expectedSignerThumbprint) {
        throw new Error("Windows release payload signer identity is inconsistent");
      }
    }
    return {
      required: required.map((path) =>
        path === input.setupPath
          ? basename(path)
          : relative(extractDir, path).replaceAll("\\", "/"),
      ),
      peCount: signedFiles.length,
    };
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

export function verifySha256(path: string, checksumPath: string): void {
  const expected = readFileSync(checksumPath, "utf8").trim().split(/\s+/u)[0];
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (!expected || expected !== actual) {
    throw new Error("Windows release artifact checksum mismatch");
  }
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function requireUniqueFile(
  files: string[],
  name: string,
  pathSuffix?: string,
): string {
  const normalizedSuffix = pathSuffix?.toLocaleLowerCase("en-US");
  const matches = files.filter((path) => {
    const normalized = path.replaceAll("\\", "/").toLocaleLowerCase("en-US");
    return basename(path).toLocaleLowerCase("en-US") ===
        name.toLocaleLowerCase("en-US") &&
      (!normalizedSuffix || normalized.includes(normalizedSuffix));
  });
  if (matches.length !== 1) {
    throw new Error(`Windows release package must contain exactly one ${name}`);
  }
  return matches[0]!;
}

function requireWindowsX64Pe(path: string, name: string): void {
  if (!isWindowsX64Pe(readFileSync(path))) {
    throw new Error(`Windows release ${name} must be an x64 PE image`);
  }
}
