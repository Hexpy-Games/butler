import { spawnSync } from "node:child_process";
import type { PreparedRun } from "./contracts.ts";
import type { ProductLaunch } from "./product-launch.ts";
import {
  readServiceState,
  type NativeServiceId,
} from "../../../packages/butler-agent/src/operations/service/native-service-supervisor.ts";
import type {
  PackagedProcessRole,
  PackagedProcessTarget,
} from "../../support/packaged-performance-snapshot.ts";

interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

const SERVICE_TARGETS: Array<{
  id: NativeServiceId;
  role: PackagedProcessRole;
  label: string;
  matcher: RegExp;
}> = [
  { id: "app-gateway", role: "app_gateway", label: "app-gateway", matcher: /app-gateway-cli/iu },
  { id: "butler-main", role: "agent_runtime", label: "butler-main", matcher: /scripts\/native-butler-main\.ts/iu },
  { id: "embed-server", role: "embed", label: "embed-server", matcher: /src\/agent\/cognition\/memory\/scripts\/embed-server\.ts/iu },
];

const SIDEcar_TARGETS: Array<{
  id: NativeServiceId;
  matcher: RegExp;
}> = [
  { id: "butler-sync-consumer", matcher: /src\/agent\/cognition\/memory\/scripts\/sync-consumer\.ts/iu },
  { id: "butler-scheduler", matcher: /scripts\/native-scheduler\.ts/iu },
  { id: "butler-watchdog", matcher: /src\/interfaces\/mcp-server\/watchdog\.ts/iu },
];

export const REQUIRED_PACKAGED_PROCESS_LABELS = [
  "electron-main",
  "electron-renderer",
  "electron-gpu",
  "electron-utility",
  "app-gateway",
  "butler-main",
  "embed-server",
  "butler-sync-consumer",
  "butler-scheduler",
  "butler-watchdog",
] as const;

export function hasCompleteProcessAttribution(targets: readonly PackagedProcessTarget[]): boolean {
  const labels = new Set(targets.map((entry) => entry.label));
  return REQUIRED_PACKAGED_PROCESS_LABELS.every((label) => labels.has(label)) &&
    labels.size === targets.length;
}

function readProcessTable(): ProcessRow[] {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`ps process discovery failed: ${String(result.stderr ?? "").trim()}`);
  }
  return result.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (!match) return [];
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    return Number.isSafeInteger(pid) && Number.isSafeInteger(ppid)
      ? [{ pid, ppid, command: match[3] ?? "" }]
      : [];
  });
}

function descendants(rows: readonly ProcessRow[], roots: readonly number[]): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const seen = new Set<number>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      queue.push(child.pid);
    }
  }
  return rows.filter((row) => seen.has(row.pid));
}

function firstMatching(rows: readonly ProcessRow[], matcher: RegExp): ProcessRow | null {
  return rows.find((row) => matcher.test(row.command)) ?? null;
}

function target(role: PackagedProcessRole, row: ProcessRow, label: string): PackagedProcessTarget {
  return { role, pid: row.pid, label };
}

/** Discover only processes belonging to the isolated Electron/App services. */
export function discoverPackagedProcessTargets(
  run: Pick<PreparedRun, "dataRoot" | "debugPort">,
  launch: Pick<ProductLaunch, "child">,
): PackagedProcessTarget[] {
  const rows = readProcessTable();
  const electronTree = descendants(rows, [launch.child.pid ?? 0]);
  const main = electronTree.find((row) =>
    /Electron\.app\/Contents\/MacOS\/Electron(?:\s|$)/u.test(row.command) &&
    !/--type=/u.test(row.command),
  ) ?? electronTree.find((row) =>
    !/--type=(renderer|gpu-process|utility)/u.test(row.command) &&
    row.command.includes(`--remote-debugging-port=${run.debugPort}`) &&
    !row.command.includes("node_modules/.bin"),
  );
  if (!main) throw new Error("Electron main process could not be identified from the isolated launch tree.");
  const targets: PackagedProcessTarget[] = [target("electron_main", main, "electron-main")];
  for (const [role, matcher, label] of [
    ["electron_renderer", /--type=renderer/iu, "electron-renderer"],
    ["electron_gpu", /--type=gpu-process/iu, "electron-gpu"],
    ["electron_utility", /--type=utility/iu, "electron-utility"],
  ] as const) {
    const match = firstMatching(electronTree, matcher);
    if (!match) throw new Error(`Electron ${role} process is absent from the real launch tree.`);
    targets.push(target(role, match, label));
  }

  const usedPids = new Set(targets.map((entry) => entry.pid));
  for (const service of SERVICE_TARGETS) {
    const state = readServiceState(run.dataRoot, service.id);
    if (!state?.pid) throw new Error(`Required owned service state is missing: ${service.id}`);
    const tree = descendants(rows, [state.pid]);
    const match = firstMatching(tree, service.matcher) ?? rows.find((row) => row.pid === state.pid) ?? null;
    if (!match || usedPids.has(match.pid)) {
      throw new Error(`Required ${service.id} process was not uniquely identified.`);
    }
    usedPids.add(match.pid);
    targets.push(target(service.role, match, service.label));
  }

  const sidecars: PackagedProcessTarget[] = [];
  for (const candidate of SIDEcar_TARGETS) {
    const state = readServiceState(run.dataRoot, candidate.id);
    if (!state?.pid) continue;
    const tree = descendants(rows, [state.pid]);
    const match = firstMatching(tree, candidate.matcher) ?? rows.find((row) => row.pid === state.pid) ?? null;
    if (!match || usedPids.has(match.pid)) continue;
    usedPids.add(match.pid);
    sidecars.push(target("owned_sidecar", match, candidate.id));
  }
  const daemon = rows.find((row) =>
    /native-service-daemon\.ts/iu.test(row.command) &&
    row.command.includes(run.dataRoot) &&
    !usedPids.has(row.pid),
  );
  if (daemon) {
    usedPids.add(daemon.pid);
    sidecars.push(target("owned_sidecar", daemon, "native-service-daemon"));
  }
  if (sidecars.length < SIDEcar_TARGETS.length) {
    throw new Error("Owned sync consumer, scheduler, and watchdog processes were not all observed.");
  }
  targets.push(...sidecars);
  return targets;
}
