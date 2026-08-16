import { expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  projectFolderTokenSecretPath,
} from "../../packages/butler-agent/src/operations/service/native-service-supervisor.ts";

const root = process.cwd();
const cli = join(root, "bin", "butler.js");

function tempRoot(): string {
  const dir = join(tmpdir(), `butler-cli-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeNativeServiceState(butlerData: string, serviceId: string, pid: number): void {
  const stateDir = join(butlerData, "state", "services");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, `${serviceId}.json`), JSON.stringify({
    version: 1,
    supervisor: "native-supervisor",
    serviceId,
    pid,
    processGroupId: pid,
    mode: "detached",
    startedAt: "2026-06-02T00:00:00.000Z",
    command: "test-command",
    args: [],
    cwd: root,
    stdoutFile: join(butlerData, "logs", `${serviceId}-out.log`),
    stderrFile: join(butlerData, "logs", `${serviceId}-err.log`),
    restartPolicy: "watchdog",
  }), "utf8");
}

test("Butler CLI help documents product commands without maintainer commands", () => {
  const result = spawnSync("node", [cli, "--help"], {
    cwd: root,
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("butler commands [--json]");
  expect(result.stdout).toContain("butler version [--json]");
  expect(result.stdout).toContain("butler status [--json]");
  expect(result.stdout).toContain("butler metrics status [--json]");
  expect(result.stdout).toContain("butler metrics tail [--lines N]");
  expect(result.stdout).toContain("butler metrics enable");
  expect(result.stdout).toContain("butler metrics disable");
  expect(result.stdout).toContain("butler service launchd-plist [--json]");
  expect(result.stdout).toContain("butler service systemd-unit [--json]");
  expect(result.stdout).toContain("butler service install");
  expect(result.stdout).toContain("butler service status");
  expect(result.stdout).toContain("butler service uninstall");
  expect(result.stdout).toContain("butler maintenance context [--json]");
  expect(result.stdout).not.toContain("butler check");
  expect(result.stdout).not.toContain("butler release gate");
});

test("installed native bin PATH exposes the butler CLI command", () => {
  const butlerData = tempRoot();
  const cliBinDir = join(butlerData, "bin");
  mkdirSync(cliBinDir, { recursive: true });
  const build = spawnSync("bun", [
    "build",
    "--compile",
    "--outfile",
    join(cliBinDir, "butler"),
    join(root, "packages", "butler-agent", "src", "interfaces", "cli", "launcher.ts"),
  ], {
    cwd: root,
    encoding: "utf8",
  });
  expect(build.status).toBe(0);

  const result = spawnSync("butler", ["--help"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      BUTLER_HOME: root,
      BUTLER_DATA: butlerData,
      PATH: `${cliBinDir}:${process.env.PATH ?? ""}`,
    },
  });

  try {
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Butler CLI");
    expect(result.stdout).toContain("butler status [--json]");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("Butler CLI commands JSON uses the shared envelope and excludes dev commands", () => {
  const result = spawnSync("node", [cli, "commands", "--json"], {
    cwd: root,
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.ok).toBe(true);
  expect(parsed.command).toBe("butler commands");
  expect(parsed.error).toBeNull();
  expect(parsed.privacy.rawTextIncluded).toBe(false);
  expect(parsed.privacy.secretsIncluded).toBe(false);

  const usages = parsed.data.commands.map((command: { usage: string }) => command.usage);
  expect(usages).toContain("butler status [--json] [--verbose]");
  expect(usages).toContain("butler metrics status [--json] [--since-hours N]");
  expect(usages).toContain("butler service run");
  expect(usages).toContain("butler service launchd-plist [--json]");
  expect(usages).toContain("butler service systemd-unit [--json]");
  expect(usages).toContain("butler service install [--platform auto|launchd|systemd] [--dry-run] [--yes] [--json]");
  expect(usages).toContain("butler service status [--platform auto|launchd|systemd] [--json]");
  expect(usages).toContain("butler service uninstall [--platform auto|launchd|systemd] [--dry-run] [--yes] [--json]");
  expect(usages).toContain("butler version [--json]");
  expect(usages).not.toContain("butler check");
  expect(usages).not.toContain("butler release gate");

  const deferred = parsed.data.commands.filter(
    (command: { priority: string }) => command.priority === "deferred",
  );
  expect(deferred.length).toBeGreaterThan(0);
  expect(deferred.every((command: { implemented: boolean }) => !command.implemented)).toBe(true);
});

test("Butler CLI service install is a safe dry-run without --yes", () => {
  const butlerData = tempRoot();

  try {
    const result = spawnSync("node", [
      cli,
      "service",
      "install",
      "--platform",
      "systemd",
      "--json",
      "--home",
      root,
      "--data",
      butlerData,
    ], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("butler service install");
    expect(parsed.data.dryRun).toBe(true);
    expect(parsed.data.mutated).toBe(false);
    expect(parsed.data.plan.serviceCount).toBe(1);
    expect(parsed.data.plan.platform).toBe("systemd");
    expect(parsed.data.plan.steps.map((step: { argv: string[] }) => step.argv.join(" "))).toContain(
      "systemctl --user enable --now butler.service",
    );
    expect(parsed.privacy.secretsIncluded).toBe(false);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("Butler CLI service adapter previews expose one foreground service", () => {
  const butlerData = tempRoot();

  try {
    const result = spawnSync("node", [cli, "service", "systemd-unit", "--json", "--home", root, "--data", butlerData], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("butler service systemd-unit");
    expect(parsed.data.serviceCount).toBe(1);
    expect(parsed.data.foregroundEntrypoint).toBe(join(root, "packages", "butler-agent", "scripts", "service-daemon.sh"));
    expect(parsed.data.body).toContain("KillMode=control-group");
    expect(parsed.data.body).not.toContain("native-scheduler.ts");
    expect(parsed.privacy.secretsIncluded).toBe(false);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("Butler CLI version JSON uses the shared envelope", () => {
  const result = spawnSync("node", [cli, "version", "--json", "--home", root], {
    cwd: root,
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.ok).toBe(true);
  expect(parsed.command).toBe("butler version");
  expect(parsed.error).toBeNull();
  expect(parsed.data.version).toBeTruthy();
  expect(parsed.data.butlerHome).toBe(root);
});

test("Butler CLI command help uses registry metadata", () => {
  const statusHelp = spawnSync("node", [cli, "status", "--help"], {
    cwd: root,
    encoding: "utf8",
  });

  expect(statusHelp.status).toBe(0);
  expect(statusHelp.stdout).toContain("butler status [--json] [--verbose]");
  expect(statusHelp.stdout).toContain("Privacy:");

  const workHelp = spawnSync("node", [cli, "work", "--help"], {
    cwd: root,
    encoding: "utf8",
  });

  expect(workHelp.status).toBe(0);
  expect(workHelp.stdout).toContain("support and recovery surface");
  expect(workHelp.stdout).toContain("butler work dashboard");
});

test("Butler CLI install help survives install-specific flags", () => {
  const result = spawnSync("node", [cli, "install", "--profile", "agent-standalone", "--help"], {
    cwd: root,
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("butler install [--profile agent-standalone]");
});

test("Butler CLI install rejects unsupported json before invoking installer", () => {
  const result = spawnSync("node", [cli, "install", "--json"], {
    cwd: root,
    encoding: "utf8",
  });

  expect(result.status).toBe(2);
  const parsed = JSON.parse(result.stdout);
  expect(parsed).toMatchObject({
    ok: false,
    command: "butler install",
    error: {
      code: "unsupported_json",
    },
  });
  expect(result.stderr).not.toContain("Unknown option");
});

test("Butler CLI unknown command returns exit code 2 and JSON envelope", () => {
  const result = spawnSync("node", [cli, "not-a-command", "--json"], {
    cwd: root,
    encoding: "utf8",
  });

  expect(result.status).toBe(2);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.ok).toBe(false);
  expect(parsed.command).toBe("butler not-a-command");
  expect(parsed.error.code).toBe("unknown_command");
  expect(parsed.privacy.secretsIncluded).toBe(false);
});

test("Butler CLI deferred commands fail explicitly instead of pretending to work", () => {
  const result = spawnSync("node", [cli, "todo", "list", "--json"], {
    cwd: root,
    encoding: "utf8",
  });

  expect(result.status).toBe(2);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.ok).toBe(false);
  expect(parsed.error.code).toBe("feature_not_stable");
  expect(parsed.error.message).toContain("butler todo list [--json]");
});

test("Butler CLI invalid common options return exit code 2 and JSON envelope", () => {
  const result = spawnSync("node", [cli, "status", "--data", "--json"], {
    cwd: root,
    encoding: "utf8",
  });

  expect(result.status).toBe(2);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.ok).toBe(false);
  expect(parsed.command).toBe("butler status");
  expect(parsed.error.code).toBe("invalid_arguments");
  expect(parsed.error.message).toContain("--data requires a path");
});

test("Butler CLI metrics status returns safe JSON for a selected data directory", () => {
  const butlerData = tempRoot();

  try {
    const result = spawnSync("node", [cli, "metrics", "status", "--json", "--data", butlerData], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("butler metrics status");
    expect(parsed.data.enabled).toBe(true);
    expect(parsed.data.operational.totalEvents).toBe(0);
    expect(parsed.data.operational.privacy.rawTextStored).toBe(false);
    expect(parsed.privacy.rawTextIncluded).toBe(false);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("Butler CLI status JSON combines health with the shared envelope", () => {
  const butlerData = tempRoot();

  try {
    writeNativeServiceState(butlerData, "butler-main", process.pid);
    const result = spawnSync("node", [cli, "status", "--json", "--data", butlerData], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("butler status");
    expect(parsed.data.status.operational.privacy.rawTextStored).toBe(false);
    expect(parsed.data.model.runtime).toBe("codex-api");
    expect(parsed.data.services.summary).toMatchObject({
      total: 6,
      online: 1,
      stale: 0,
    });
    expect(parsed.data.services.items.find((service: { serviceId: string }) => service.serviceId === "butler-main")).toMatchObject({
      serviceId: "butler-main",
      name: "butler-agent",
      status: "online",
      pid: process.pid,
    });
    expect(parsed.data.services.items.find((service: { serviceId: string }) => service.serviceId === "app-gateway")).toMatchObject({
      serviceId: "app-gateway",
      name: "gateway-app",
      status: "offline",
      pid: null,
    });
    expect(JSON.stringify(parsed.data.services)).not.toContain(butlerData);
    expect(existsSync(projectFolderTokenSecretPath(butlerData))).toBe(false);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("Butler CLI status human output includes service health", () => {
  const butlerData = tempRoot();

  try {
    writeNativeServiceState(butlerData, "butler-main", process.pid);
    const result = spawnSync("node", [cli, "status", "--data", butlerData], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("## Services");
    expect(result.stdout).toContain("butler-agent: online");
    expect(result.stdout).toContain("gateway-app: offline");
    expect(result.stdout).not.toContain(butlerData);
    expect(existsSync(projectFolderTokenSecretPath(butlerData))).toBe(false);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("Butler CLI auth status reports configured auth without leaking secrets", () => {
  const butlerData = tempRoot();

  try {
    writeFileSync(join(butlerData, ".env"), "OPENAI_API_KEY=sk-secret-value\n");
    const result = spawnSync("node", [cli, "auth", "status", "--json", "--data", butlerData], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("sk-secret-value");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.configured).toBe(true);
    expect(parsed.data.mode).toBe("api_key");
    expect(parsed.data.redacted).toBe(true);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("Butler CLI model status uses runtime provider model and cache envelope", () => {
  const butlerData = tempRoot();

  try {
    writeFileSync(join(butlerData, "butler.config.json"), JSON.stringify({
      system: {
        runtime: "codex-api",
        openaiModel: "gpt-5.5-codex",
        openaiPromptCacheKeyPrefix: "butler-test",
      },
    }));
    const result = spawnSync("node", [cli, "model", "status", "--json", "--data", butlerData], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("butler model status");
    expect(parsed.data.runtime).toBe("codex-api");
    expect(parsed.data.provider).toBe("openai");
    expect(parsed.data.modelRef).toBe("openai/gpt-5.5-codex");
    expect(parsed.data.promptCache.configured).toBe(true);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("Butler CLI runtime repair requires explicit confirmation", () => {
  const result = spawnSync("node", [cli, "runtime", "repair", "--json"], {
    cwd: root,
    encoding: "utf8",
  });

  expect(result.status).toBe(2);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.ok).toBe(false);
  expect(parsed.error.code).toBe("invalid_arguments");
  expect(parsed.error.message).toContain("--yes");
});

test("Butler CLI metrics enable and disable update the private data config", () => {
  const butlerData = tempRoot();

  try {
    const disabled = spawnSync("node", [cli, "metrics", "disable", "--home", root, "--data", butlerData], {
      cwd: root,
      encoding: "utf8",
    });
    expect(disabled.status).toBe(0);

    let config = JSON.parse(readFileSync(join(butlerData, "butler.config.json"), "utf8"));
    expect(config.metrics.enabled).toBe(false);

    const enabled = spawnSync("node", [cli, "metrics", "enable", "--home", root, "--data", butlerData], {
      cwd: root,
      encoding: "utf8",
    });
    expect(enabled.status).toBe(0);

    config = JSON.parse(readFileSync(join(butlerData, "butler.config.json"), "utf8"));
    expect(config.metrics.enabled).toBe(true);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
}, 15_000);
