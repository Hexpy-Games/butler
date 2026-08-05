import { spawnSync } from "node:child_process";
import { drainAppForegroundActiveWork } from "../../client/electron/app-foreground-drain.mjs";
import { quitAndInstallAppUpdate } from "../../client/electron/app-foreground-update.mjs";
import {
  classifyAppForegroundActiveWork,
  confirmAppForegroundQuit,
} from "../../client/electron/app-foreground-quit.mjs";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("active-work cancellation smoke requires Windows x64");
}

const snapshot = classifyAppForegroundActiveWork({
  navigation: {
    chats: [{
      id: "session-active",
      active_turn_id: "turn-active",
      active_turn_state: "streaming",
    }],
  },
  workerActivity: {
    workers: [{
      worker_id: "worker-active",
      status: "running",
    }],
  },
  queues: [{ items: [{ id: "queued-follow-up" }] }],
});

const cancelPreserved = !(await confirmAppForegroundQuit({
  snapshot,
  showMessageBox: async () => ({ response: 0 }),
}));
const continueAccepted = await confirmAppForegroundQuit({
  snapshot,
  showMessageBox: async () => ({ response: 1 }),
});
const cancelledTurns: string[] = [];
const cancelledWorkers: string[] = [];
let reads = 0;
const drain = await drainAppForegroundActiveWork({
  snapshot,
  cancelTurn: async (turnId) => {
    cancelledTurns.push(turnId);
  },
  cancelWorker: async (workerId) => {
    cancelledWorkers.push(workerId);
  },
  readSnapshot: async () => ({
    classification: reads++ > 0 ? "no_active_work" : "active_work_detected",
  }),
  sleepMs: async () => undefined,
});
const cancelledUpdateCalls: string[] = [];
const cancelledUpdate = await quitAndInstallAppUpdate({
  readActiveWork: async () => snapshot,
  confirmQuit: async () => false,
  stopForUpdate: async () => {
    cancelledUpdateCalls.push("stop");
    return { update_ready: true };
  },
  quitAndInstall: () => {
    cancelledUpdateCalls.push("install");
  },
});
const updateCalls: string[] = [];
const acceptedUpdate = await quitAndInstallAppUpdate({
  readActiveWork: async () => {
    updateCalls.push("read");
    return snapshot;
  },
  confirmQuit: async () => {
    updateCalls.push("confirm");
    return true;
  },
  stopForUpdate: async () => {
    updateCalls.push("drain-stop");
    return { update_ready: true };
  },
  quitAndInstall: () => {
    updateCalls.push("quit-install");
  },
});
const standardUser = isMediumIntegrityProcess();
const result = {
  ok:
    standardUser &&
    cancelPreserved &&
    continueAccepted &&
    snapshot.classification === "active_work_detected" &&
    cancelledTurns.join(",") === "turn-active" &&
    cancelledWorkers.join(",") === "worker-active" &&
    drain.status === "settled" &&
    drain.settled === true &&
    cancelledUpdate.status === "cancelled" &&
    cancelledUpdateCalls.length === 0 &&
    acceptedUpdate.status === "update_started" &&
    updateCalls.join(",") === "read,confirm,drain-stop,quit-install",
  platform: `${process.platform}-${process.arch}`,
  standardUser,
  cancelPreserved,
  continueAccepted,
  exactTurnCancellation: cancelledTurns.length === 1,
  exactWorkerCancellation: cancelledWorkers.length === 1,
  boundedDrain: drain.settled === true,
  cancelledUpdatePreserved: cancelledUpdateCalls.length === 0,
  updaterWaitedForDrain:
    updateCalls.join(",") === "read,confirm,drain-stop,quit-install",
  rawTextIncluded: false,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!result.ok) process.exitCode = 1;

function isMediumIntegrityProcess(): boolean {
  const groups = spawnSync("whoami.exe", ["/groups", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return groups.status === 0 &&
    String(groups.stdout).includes("S-1-16-8192") &&
    !String(groups.stdout).includes("S-1-16-12288");
}
