import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

if (process.platform !== "win32") {
  throw new Error("interactive smoke controller requires Windows");
}

const signedBun = requiredArgument("--signed-bun");
const signedHost = requiredArgument("--signed-host");
const signingThumbprint = requiredArgument("--signing-thumbprint");
const smoke = requiredArgument("--smoke");
const output = requiredArgument("--output");
const integrity = spawnSync("whoami.exe", ["/groups", "/fo", "csv", "/nh"], {
  encoding: "utf8",
  windowsHide: true,
});

if (integrity.status !== 0 || !integrity.stdout.includes("S-1-16-8192")) {
  writeFileSync(output, "interactive smoke controller is not standard-user\r\n");
  process.exit(1);
}

const child = spawn(signedBun, ["run", smoke], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    BUTLER_BUN: signedBun,
    BUTLER_APP_MANAGED_BUN_WIN32_X64: signedBun,
    BUTLER_APP_WINDOWS_PROCESS_HOST: signedHost,
    BUTLER_WINDOWS_PROCESS_HOST: signedHost,
    BUTLER_WINDOWS_SIGN_CERTIFICATE_SHA1: signingThumbprint,
    BUTLER_WINDOWS_STANDARD_USER: "1",
  },
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: false,
});

let captured = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    captured = `${captured}${String(chunk)}`.slice(-262_144);
  });
}
child.once("error", (error) => {
  captured = `${captured}${error.name}\r\n`.slice(-262_144);
});
const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
  (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
);
writeFileSync(
  output,
  `${captured.trim()}\r\n__EXIT__=${exit.code ?? "null"}\r\n`,
  "utf8",
);
process.exit(exit.code ?? 1);

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : null;
  if (!value) throw new Error(`${name} is required`);
  return value;
}
