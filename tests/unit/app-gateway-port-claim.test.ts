import { expect, test } from "bun:test";
import {
  isCanonicalButlerData,
  reclaimStaleAppGatewayPort,
  type AppGatewayPortClaimDeps,
  type ProcessInspection,
} from "../../packages/butler-agent/src/gateways/app/port-claim.ts";

function deps(input: {
  listeners: number[];
  processes: Record<number, ProcessInspection>;
  killed?: number[];
}): AppGatewayPortClaimDeps {
  return {
    findListeners: () => input.listeners,
    inspectProcess: (pid) => input.processes[pid] ?? null,
    killPid: (pid) => {
      input.killed?.push(pid);
      input.listeners = input.listeners.filter((listener) => listener !== Math.abs(pid));
    },
    sleepMs: () => undefined,
  };
}

function appGatewayProcess(input: {
  butlerHome: string;
  butlerData: string;
}): ProcessInspection {
  return {
    command: [
      "/opt/homebrew/bin/bun",
      "run",
      `${input.butlerHome}/packages/butler-agent/src/gateways/app/cli.ts`,
      "--port=18765",
      `BUTLER_HOME=${input.butlerHome}`,
      `BUTLER_DATA=${input.butlerData}`,
    ].join(" "),
    env: {
      BUTLER_HOME: input.butlerHome,
      BUTLER_DATA: input.butlerData,
    },
  };
}

test("canonical Butler data can reclaim a foreign worktree app gateway listener", () => {
  const killed: number[] = [];
  const result = reclaimStaleAppGatewayPort(
    {
      port: 18765,
      hostname: "127.0.0.1",
      butlerHome: "/Users/me/butler",
      butlerData: "/Users/me/.butler",
      userHome: "/Users/me",
      currentPid: 9000,
    },
    deps({
      listeners: [1234],
      killed,
      processes: {
        1234: appGatewayProcess({
          butlerHome: "/Users/me/.codex/worktrees/0929/butler",
          butlerData: "/var/folders/tmp-worktree",
        }),
      },
    }),
  );

  expect(result).toEqual({ reclaimedPids: [1234], skipped: null });
  expect(killed).toEqual([-1234]);
});

test("non-canonical Butler data cannot reclaim the user app gateway port", () => {
  const killed: number[] = [];
  const result = reclaimStaleAppGatewayPort(
    {
      port: 18765,
      hostname: "127.0.0.1",
      butlerHome: "/Users/me/.codex/worktrees/0929/butler",
      butlerData: "/var/folders/tmp-worktree",
      userHome: "/Users/me",
      currentPid: 9001,
    },
    deps({
      listeners: [1234],
      killed,
      processes: {
        1234: appGatewayProcess({
          butlerHome: "/Users/me/butler",
          butlerData: "/Users/me/.butler",
        }),
      },
    }),
  );

  expect(result).toEqual({
    reclaimedPids: [],
    skipped: "non-canonical-data",
  });
  expect(killed).toEqual([]);
});

test("canonical port claim leaves the same runtime and non-Butler listeners alone", () => {
  const killed: number[] = [];
  const result = reclaimStaleAppGatewayPort(
    {
      port: 18765,
      hostname: "127.0.0.1",
      butlerHome: "/Users/me/butler",
      butlerData: "/Users/me/.butler",
      userHome: "/Users/me",
      currentPid: 9002,
    },
    deps({
      listeners: [1234, 2345],
      killed,
      processes: {
        1234: appGatewayProcess({
          butlerHome: "/Users/me/butler",
          butlerData: "/Users/me/.butler",
        }),
        2345: {
          command: "/usr/bin/python3 -m http.server 18765",
          env: {},
        },
      },
    }),
  );

  expect(result).toEqual({ reclaimedPids: [], skipped: null });
  expect(killed).toEqual([]);
});

test("canonical port claim escalates when a stale listener ignores SIGTERM", () => {
  const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const listeners = [1234];
  const result = reclaimStaleAppGatewayPort(
    {
      port: 18765,
      hostname: "127.0.0.1",
      butlerHome: "/Users/me/butler",
      butlerData: "/Users/me/.butler",
      userHome: "/Users/me",
      currentPid: 9003,
      waitMs: 0,
    },
    {
      findListeners: () => listeners,
      inspectProcess: (pid) =>
        pid === 1234
          ? appGatewayProcess({
              butlerHome: "/Users/me/.codex/worktrees/0929/butler",
              butlerData: "/var/folders/tmp-worktree",
            })
          : null,
      killPid: (pid, signal) => {
        killed.push({ pid, signal });
        if (signal === "SIGKILL") listeners.splice(0, listeners.length);
      },
      sleepMs: () => undefined,
    },
  );

  expect(result).toEqual({ reclaimedPids: [1234], skipped: null });
  expect(killed).toEqual([
    { pid: -1234, signal: "SIGTERM" },
    { pid: -1234, signal: "SIGKILL" },
  ]);
});

test("canonical data check follows the user home data root", () => {
  expect(isCanonicalButlerData("/Users/me/.butler", "/Users/me")).toBe(true);
  expect(isCanonicalButlerData("/var/folders/tmp-worktree", "/Users/me")).toBe(
    false,
  );
});
