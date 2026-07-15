import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

if (process.platform !== "win32") {
  throw new Error("Windows process host must be built on Windows");
}

const root = resolve(import.meta.dir, "../../../..");
const source = join(
  root,
  "packages",
  "butler-agent",
  "native",
  "windows-process-host",
  "ButlerProcessHost.cs",
);
const output = resolve(
  process.argv[2] ??
    join(root, "dist", "native", "win32-x64", "butler-process-host.exe"),
);
const compiler = resolveCompiler();
mkdirSync(dirname(output), { recursive: true });
const result = spawnSync(
  compiler,
  [
    "/nologo",
    "/optimize+",
    "/platform:x64",
    "/target:exe",
    `/out:${output}`,
    source,
  ],
  { encoding: "utf8", windowsHide: true },
);
if (result.status !== 0 || !existsSync(output)) {
  throw new Error(
    `Windows process host build failed: ${[result.stdout, result.stderr].filter(Boolean).join("\n").slice(-4000)}`,
  );
}
process.stdout.write(`${JSON.stringify({ ok: true, output, compiler })}\n`);

function resolveCompiler(): string {
  const explicit = process.env.BUTLER_WINDOWS_CSC?.trim();
  const candidates = [
    explicit,
    join(
      process.env.WINDIR ?? "C:\\Windows",
      "Microsoft.NET",
      "Framework64",
      "v4.0.30319",
      "csc.exe",
    ),
  ].filter((value): value is string => Boolean(value));
  const compiler = candidates.find((value) => existsSync(value));
  if (!compiler) throw new Error("Windows x64 C# compiler is unavailable");
  return compiler;
}
