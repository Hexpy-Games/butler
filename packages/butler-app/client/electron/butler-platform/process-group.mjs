import { spawnSync } from "node:child_process";

/** Signal only a process tree whose detached leader was spawned by the caller. */
export function killOwnedProcessGroup(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid owned process PID");
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    if (result.error) throw result.error;
    if (result.status !== 0 && ownedProcessGroupAlive(pid)) throw new Error(`Process tree ${pid} did not stop`);
    return;
  }
  try { process.kill(-pid, "SIGKILL"); }
  catch (error) {
    if (error.code === "ESRCH") return;
    if (error.code !== "EPERM") throw error;
    // Restricted runners may refuse group delivery (including an empty group).
    // Enumerate only membership by PGID, then signal those exact owned PIDs.
    for (const member of groupMembers(pid)) {
      try { process.kill(member, "SIGKILL"); }
      catch (failure) { if (failure.code !== "ESRCH") throw failure; }
    }
  }
}

export function ownedProcessGroupAlive(pid) {
  try { process.kill(process.platform === "win32" ? pid : -pid, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM" && process.platform !== "win32") return groupMembers(pid).length > 0;
    throw error;
  }
}

function groupMembers(pid) {
  const result = spawnSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Process group membership unavailable");
  return result.stdout.trim().split("\n").flatMap(line => {
    const [member, group] = line.trim().split(/\s+/u).map(Number);
    return group === pid && member > 0 ? [member] : [];
  });
}
