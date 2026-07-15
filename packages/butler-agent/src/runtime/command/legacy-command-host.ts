import { spawn } from "node:child_process";

const encodedCommand = process.env.BUTLER_LEGACY_COMMAND_BASE64?.trim() ?? "";
const command = encodedCommand
  ? Buffer.from(encodedCommand, "base64").toString("utf8").trim()
  : "";
if (!command) {
  process.stderr.write("legacy command compatibility input is empty\n");
  process.exit(64);
}

const invocation = process.platform === "win32"
  ? {
      executable: process.env.BUTLER_POWERSHELL?.trim() || "powershell.exe",
      arguments: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command,
      ],
    }
  : {
      executable: "/bin/bash",
      arguments: process.argv.includes("--pipefail")
        ? ["-o", "pipefail", "-lc", command]
        : ["-lc", command],
    };

const child = spawn(invocation.executable, invocation.arguments, {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  stdio: "inherit",
  windowsHide: true,
});

child.once("error", () => {
  process.stderr.write("legacy command compatibility process could not be started\n");
  process.exit(127);
});
child.once("exit", (code) => process.exit(code ?? 1));
