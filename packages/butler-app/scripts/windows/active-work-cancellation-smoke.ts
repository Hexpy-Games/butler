import { spawnSync } from "node:child_process";
import { drainAppForegroundActiveWork } from "../../client/electron/app-foreground-drain.mjs";
import { createAppUpdateCoordinator } from "../../client/electron/app-foreground-update.mjs";
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
  queues: [{ items: [{ id: "queued-follow-up", state: "queued" }] }],
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
const updateCalls: string[] = [];
const updateCoordinator = createAppUpdateCoordinator({
  readActiveWork: async () => snapshot,
  watchWork: () => () => {},
  stopForUpdate: async () => { updateCalls.push("checkpoint"); return { update_ready: true }; },
  onState: (state) => {
    if (state.status === "choice_required") {
      updateCoordinator.choose({ request_id: state.request_id, action: "now" });
    }
  },
});
const acceptedUpdate = await updateCoordinator.request(async () => ({
  activate: () => { updateCalls.push("activate"); }, cancel: () => {},
}));
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
    acceptedUpdate.status === "update_started" &&
    updateCalls.join(",") === "checkpoint,activate",
  platform: `${process.platform}-${process.arch}`,
  standardUser,
  cancelPreserved,
  continueAccepted,
  exactTurnCancellation: cancelledTurns.length === 1,
  exactWorkerCancellation: cancelledWorkers.length === 1,
  boundedDrain: drain.settled === true,
  updaterWaitedForDrain:
    updateCalls.join(",") === "checkpoint,activate",
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
