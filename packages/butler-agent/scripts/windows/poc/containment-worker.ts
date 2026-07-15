import { spawn } from "node:child_process";

const port = Number(process.env.BUTLER_WINDOWS_POC_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("BUTLER_WINDOWS_POC_PORT must be a valid TCP port.");
}

if (process.argv.includes("--descendant")) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: () => Response.json({ ok: true }),
  });
  console.log(
    JSON.stringify({
      type: "descendant-ready",
      pid: process.pid,
      port: server.port,
    }),
  );
  setInterval(() => undefined, 60 * 60 * 1000);
} else {
  process.stdin.setEncoding("utf8");
  process.stdin.once("data", () => {
    const descendant = spawn(
      process.execPath,
      ["run", import.meta.filename, "--descendant"],
      {
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    descendant.stdout.setEncoding("utf8");
    descendant.stderr.setEncoding("utf8");
    descendant.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const lineEnd = stdout.indexOf("\n");
      if (lineEnd < 0) return;
      const ready = JSON.parse(stdout.slice(0, lineEnd)) as { type?: string };
      if (ready.type !== "descendant-ready") {
        throw new Error("Unexpected descendant readiness payload.");
      }
      console.log(
        JSON.stringify({
          type: "worker-ready",
          pid: process.pid,
          descendantPid: descendant.pid,
          port,
        }),
      );
    });
    descendant.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_192);
    });
    descendant.once("exit", (code) => {
      if (code !== null && code !== 0) console.error(stderr);
      process.exit(code ?? 1);
    });
  });
}
