import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

test("Windows process host binds Job Object lifetime to the App owner", () => {
  const source = readFileSync(join(
    process.cwd(),
    "packages",
    "butler-agent",
    "native",
    "windows-process-host",
    "ButlerProcessHost.cs",
  ), "utf8");

  expect(source).toContain('args[0] == "--owner-pid"');
  expect(source).toContain("OpenProcess(SYNCHRONIZE");
  expect(source).toContain("WaitForMultipleObjects(");
  expect(source).toContain("new IntPtr[] { process, owner }");
  expect(source).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE");
  expect(source).toMatch(/if \(job != IntPtr\.Zero\) CloseHandle\(job\)/u);
});

test("Windows process host is compiled as an x64 GUI executable", () => {
  const source = readFileSync(join(
    process.cwd(),
    "packages",
    "butler-agent",
    "scripts",
    "windows",
    "build-process-host.ts",
  ), "utf8");

  expect(source).toContain('"/platform:x64"');
  expect(source).toContain('"/target:winexe"');
  expect(source).not.toContain('"/target:exe"');
});

test("Windows installer emits the canonical MSI and retains Squirrel output", () => {
  const source = readFileSync(join(
    process.cwd(),
    "packages",
    "butler-app",
    "client",
    "electron",
    "scripts",
    "create-windows-installer.mjs",
  ), "utf8");

  expect(source).toContain('requiredOption("--setup-msi")');
  expect(source).toContain("setupMsi");
  expect(source).toContain("noMsi: false");
});

test("Windows GUI smoke escapes the Task Job through the logged-in Explorer", () => {
  const source = readFileSync(join(
    process.cwd(),
    "packages",
    "butler-app",
    "scripts",
    "windows",
    "run-bundled-payload-smoke-child.ps1",
  ), "utf8");

  expect(source).toContain("WScript.Shell");
  expect(source).toContain("explorer.exe $shortcutPath");
  expect(source).toContain("Interactive standard-user smoke controller timed out");
});
