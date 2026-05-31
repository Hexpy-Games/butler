#!/usr/bin/env bun
import {
  listServices,
  resolveNativeSupervisorPaths,
  startServices,
  stopServices,
  type NativeServiceProjection,
} from "../src/operations/service/native-service-supervisor.ts";

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
const paths = resolveNativeSupervisorPaths();

let services: NativeServiceProjection[];

if (command === "start") {
  services = startServices(paths);
} else if (command === "stop") {
  services = stopServices(paths);
} else if (command === "restart") {
  stopServices(paths);
  services = startServices(paths);
} else if (command === "ps" || command === "status") {
  services = listServices(paths);
} else {
  console.error(`unknown native service command: ${command}`);
  process.exit(2);
}

if (json) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    supervisor: "native-supervisor",
    command,
    services,
    privacy: {
      rawTextIncluded: false,
      secretsIncluded: false,
    },
  }, null, 2)}\n`);
} else {
  process.stdout.write(`${render(services)}\n`);
}

