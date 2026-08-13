#!/usr/bin/env bun
import { accessSync, constants, existsSync, mkdirSync } from "fs";
import { delimiter, dirname, isAbsolute, join } from "path";
import {
  defaultNativeServiceSpecs,
  listServices,
  resolveNativeSupervisorPaths,
  startServices,
  stopServiceBounded,
  stopServices,
  type NativeServiceProjection,
  type NativeServiceSpec,
} from "../src/operations/service/native-service-supervisor.ts";
import {
  prepareAgentStorageForNativeServiceLaunch,
  restartNativeServicesAfterStoragePreparation,
} from
  "../src/operations/service/native-service-storage-preparation.ts";

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function render(services: NativeServiceProjection[]): string {
  return services
    .map((service) =>
      `${service.serviceId}: ${service.status} pid=${service.pid ?? "none"} supervisor=${service.supervisor}`,
    )
    .join("\n");
}

const [command = "ps", ...args] = Bun.argv.slice(2);
const json = hasFlag(args, "--json");
const dryRun = hasFlag(args, "--dry-run");
const paths = resolveNativeSupervisorPaths();

let services: NativeServiceProjection[];
let preflight: NativeServiceDryRunPreflight[] | undefined;

if (command === "start" && dryRun) {
  const specs = defaultNativeServiceSpecs(paths, { createProjectFolderTokenSecret: false });
  preflight = specs.map(preflightServiceStart);
  services = specs.map(projectDryRunService);
} else if (command === "start") {
  await prepareStorageBeforeStart();
  services = startServices(paths);
} else if (command === "stop") {
  services = stopServices(paths);
} else if (command === "restart") {
  services = await restartNativeServicesAfterStoragePreparation({
    prepareStorage: prepareStorageBeforeStart,
    stopServices: () => { stopServices(paths); },
    startServices: () => startServices(paths),
  });
} else if (command === "ps" || command === "status") {
  services = listServices(paths);
} else {
  console.error(`unknown native service command: ${command}`);
  process.exit(2);
}

async function prepareStorageBeforeStart(): Promise<void> {
  const specs = defaultNativeServiceSpecs(paths);
  const appGateway = specs.find((spec) => spec.id === "app-gateway");
  await prepareAgentStorageForNativeServiceLaunch({
    butlerData: paths.butlerData,
    runtimeVersion: "native-service-split-v1",
    quiesceLegacyWriter: async () => {
      if (appGateway) {
        await stopServiceBounded(paths.butlerData, appGateway);
      }
    },
  });
}

if (json) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    supervisor: "native-supervisor",
    command,
    dryRun,
    ...(preflight ? { preflight } : {}),
    services,
    privacy: {
      rawTextIncluded: false,
      secretsIncluded: false,
    },
  }, null, 2)}\n`);
} else {
  process.stdout.write(`${dryRun ? "dry-run\n" : ""}${render(services)}\n`);
}

interface NativeServiceDryRunPreflight {
  serviceId: string;
  ok: boolean;
  issues: string[];
}

function projectDryRunService(spec: NativeServiceSpec): NativeServiceProjection {
  return {
    serviceId: spec.id,
    pid: null,
    parentPid: null,
    processGroupId: null,
    status: "offline",
    startedAt: null,
    supervisor: "native-supervisor",
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    stdoutFile: spec.stdoutFile,
    stderrFile: spec.stderrFile,
    restartPolicy: spec.restartPolicy,
  };
}

function preflightServiceStart(spec: NativeServiceSpec): NativeServiceDryRunPreflight {
  const issues: string[] = [];
  if (!existsSync(spec.cwd)) {
    issues.push(`cwd missing: ${spec.cwd}`);
  }
  if (!commandAvailable(spec.command)) {
    issues.push(`command unavailable: ${spec.command}`);
  }
  for (const logPath of [spec.stdoutFile, spec.stderrFile]) {
    try {
      mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
      accessSync(dirname(logPath), constants.W_OK);
    } catch {
      issues.push(`log directory not writable: ${dirname(logPath)}`);
    }
  }
  return {
    serviceId: spec.id,
    ok: issues.length === 0,
    issues,
  };
}

function commandAvailable(command: string): boolean {
  if (isAbsolute(command) || command.includes("/")) {
    try {
      accessSync(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  for (const segment of (process.env.PATH ?? "").split(delimiter)) {
    if (!segment) continue;
    try {
      accessSync(join(segment, command), constants.X_OK);
      return true;
    } catch {
      // Continue searching PATH.
    }
  }
  return false;
}

if (dryRun && preflight?.some((item) => !item.ok)) {
  process.exitCode = 1;
}
