import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createConnection } from "node:net";
import { basename, resolve } from "node:path";

const startupTimeoutMs = 45_000;
const shutdownTimeoutMs = 10_000;

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("This smoke test must run on Windows.");
  }

  const payloadRoot = requireEnv("BUTLER_WINDOWS_POC_PAYLOAD");
  const dataRoot = requireEnv("BUTLER_WINDOWS_POC_DATA");
  const expectedRuntime = requireEnv("BUTLER_WINDOWS_POC_EXPECTED_RUNTIME");
  const port = parsePort(requireEnv("BUTLER_WINDOWS_POC_PORT"));
  const actualRuntime = process.execPath;

  if (normalizeWindowsPath(actualRuntime) !== normalizeWindowsPath(expectedRuntime)) {
    throw new Error("Smoke test was not launched by the expected bundled runtime.");
  }

  const gatewayEntry = resolve(
    import.meta.dir,
    "../../src/gateways/app/interface/cli/app-gateway-cli.ts",
  );
  const child = spawn(actualRuntime, ["run", gatewayEntry], {
    cwd: payloadRoot,
    env: {
      ...process.env,
      BUTLER_HOME: payloadRoot,
      BUTLER_APP_BUTLER_HOME: payloadRoot,
      BUTLER_DATA: dataRoot,
      BUTLER_BUN: actualRuntime,
      BUTLER_APP_BUNDLED_SUPERVISOR: "1",
      BUTLER_APP_GATEWAY_PID_FILE: "off",
      BUTLER_APP_SERVER_HOST: "127.0.0.1",
      BUTLER_APP_SERVER_PORT: String(port),
    },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin.end();
  const output = collectOutput(child);

  try {
    const health = await waitForHealth(child, port, startupTimeoutMs, output);
    const healthData = health.data as Record<string, unknown> | undefined;
    if (healthData?.ok !== true || healthData.service !== "butler-app-server") {
      throw new Error("Gateway health response did not satisfy the App protocol contract.");
    }
    child.kill();
    await waitForExit(child, shutdownTimeoutMs);
    const portReleased = await waitForPortRelease(port, shutdownTimeoutMs);
    if (!portReleased) {
      throw new Error("Gateway port remained open after the bundled process exited.");
    }

    console.log(
      JSON.stringify({
        ok: true,
        platform: process.platform,
        runtime: basename(actualRuntime),
        globalRuntimeUsed: false,
        shellUsed: false,
        unicodeAndSpacePath:
          [...payloadRoot].some((character) => character.charCodeAt(0) > 127) &&
          payloadRoot.includes(" "),
        health: {
          ok: healthData.ok,
          service: healthData.service,
        },
        stopped: true,
        portReleased,
        rawTextIncluded: false,
      }),
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await waitForExit(child, shutdownTimeoutMs).catch(() => undefined);
    }
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("BUTLER_WINDOWS_POC_PORT must be a valid TCP port.");
  }
  return port;
}

function normalizeWindowsPath(path: string): string {
  return resolve(path).replaceAll("/", "\\").toLowerCase();
}

function collectOutput(child: ChildProcessWithoutNullStreams): {
  stdout: string;
  stderr: string;
} {
  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output.stdout = appendBounded(output.stdout, chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    output.stderr = appendBounded(output.stderr, chunk);
  });
  return output;
}

function appendBounded(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-16_384);
}

async function waitForHealth(
  child: ChildProcessWithoutNullStreams,
  port: number,
  timeoutMs: number,
  output: { stdout: string; stderr: string },
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Gateway exited before health check. stdout=${output.stdout} stderr=${output.stderr}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return (await response.json()) as Record<string, unknown>;
    } catch {
      // The gateway is still starting.
    }
    await Bun.sleep(250);
  }
  throw new Error(
    `Timed out waiting for gateway health. stdout=${output.stdout} stderr=${output.stderr}`,
  );
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for bundled gateway process to exit."));
    }, timeoutMs);
    const onExit = (): void => {
      cleanup();
      resolvePromise();
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

async function waitForPortRelease(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) return true;
    await Bun.sleep(100);
  }
  return false;
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open: boolean): void => {
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

await main();
