import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";
import type { CommandExecutor } from "../../packages/butler-agent/src/runtime/command/contracts.ts";
import {
  buildPlatformDoctorReport,
  PlatformDoctorInputError,
  renderPlatformDoctorReport,
} from "../../packages/butler-agent/src/operations/doctor/platform-doctor.ts";

test("platform doctor returns stable healthy capabilities without adapter names", async () => {
  const root = join(tmpdir(), `butler-platform-doctor-${process.pid}-${Date.now()}`);
  try {
    writeRuntimeFixture(root);
    const report = await buildPlatformDoctorReport({
      butlerHome: root,
      butlerData: join(root, "data"),
      executor: healthyExecutor,
      runtimeExecutable: process.execPath,
      platform: "linux",
    });
    expect(report).toMatchObject({
      schema: "butler.platform-doctor.v1",
      status: "healthy",
      exitCode: 0,
      capabilities: {
        commandExecution: true,
        processContainment: true,
        cancellation: true,
        managedPayload: true,
        updater: true,
        appForegroundAgent: true,
        backgroundServiceInstall: {
          supported: false,
          reason: "app_foreground_owned",
        },
      },
      rawTextIncluded: false,
    });
    expect(JSON.stringify(report)).not.toMatch(/bash|powershell|adapter/iu);
    expect(renderPlatformDoctorReport(report)).toContain("Butler doctor: healthy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("platform doctor reports degraded missing Windows payload prerequisites", async () => {
  const root = join(tmpdir(), `butler-platform-doctor-win-${process.pid}-${Date.now()}`);
  try {
    writeRuntimeFixture(root);
    const report = await buildPlatformDoctorReport({
      butlerHome: root,
      butlerData: join(root, "data"),
      env: { BUTLER_APP_MANAGED_RUNTIME_HOME: root },
      executor: healthyExecutor,
      runtimeExecutable: join(root, "runtime", "bin", "bun.exe"),
      platform: "win32",
    });
    expect(report.status).toBe("degraded");
    expect(report.exitCode).toBe(1);
    expect(report.checks.find((check) => check.id === "payload")?.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "cancellation")?.status).toBe("fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("platform doctor rejects unknown logical checks with a stable error", async () => {
  expect(
    buildPlatformDoctorReport({
      butlerHome: process.cwd(),
      butlerData: join(process.cwd(), ".tmp"),
      executor: healthyExecutor,
      check: "shell",
    }),
  ).rejects.toBeInstanceOf(PlatformDoctorInputError);
});

test("platform doctor CLI keeps stable exit codes and redacts invalid check text", () => {
  const root = join(tmpdir(), `butler-platform-doctor-cli-${process.pid}-${Date.now()}`);
  const cli = join(process.cwd(), "bin", "butler.js");
  const run = (...args: string[]) => spawnSync("node", [
    cli,
    "doctor",
    "--json",
    "--home",
    root,
    "--data",
    join(root, "data"),
    ...args,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, BUTLER_BUN: process.execPath },
  });
  try {
    mkdirSync(root, { recursive: true });
    const degraded = run();
    expect(degraded.status).toBe(1);

    const unsupported = run("--fix");
    expect(unsupported.status).toBe(3);
    expect(JSON.parse(unsupported.stdout).error.code).toBe(
      "unsupported_logical_operation",
    );

    const invalidSecret = "secret-check-value-must-not-leak";
    const invalid = run("--check", invalidSecret);
    expect(invalid.status).toBe(2);
    expect(JSON.parse(invalid.stdout).error).toEqual({
      code: "unsupported_logical_operation",
      message: "unsupported doctor check",
    });
    expect(invalid.stdout).not.toContain(invalidSecret);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const healthyExecutor: CommandExecutor = {
  async execute(request) {
    const source = request.plan.steps[0]?.arguments?.join(" ") ?? "";
    if (request.timeoutMs === 50) {
      return result({ exitCode: null, timedOut: true });
    }
    if (source.includes("--version")) return result({ stdout: "1.3.11\n" });
    return result({ stdout: "butler-command-health" });
  },
};

function result(
  input: Partial<Awaited<ReturnType<CommandExecutor["execute"]>>> = {},
): Awaited<ReturnType<CommandExecutor["execute"]>> {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    durationMs: 1,
    error: null,
    ...input,
  };
}

function writeRuntimeFixture(root: string): void {
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(
    join(root, "packages", "butler-agent", "resources", "runtime"),
    { recursive: true },
  );
  writeFileSync(join(root, "bin", "butler.js"), "");
  writeFileSync(
    join(root, "packages", "butler-agent", "resources", "runtime", "bun-version"),
    "1.3.11\n",
  );
}
