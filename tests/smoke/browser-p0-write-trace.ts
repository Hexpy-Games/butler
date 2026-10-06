import { spawn } from "node:child_process";
/** Exact owned PIDs only. Raw filesystem paths are never printed or retained. */
export function startWriteTrace(pids: number[], seconds: number) {
  if (process.platform !== "darwin") return Promise.resolve({ available: false, reason: "Windows needs process-attributed ETW FileIO capture", writes: null, unresolved: 0 });
  if (!pids.every(pid => Number.isSafeInteger(pid) && pid > 0)) throw new Error("Owned PIDs required");
  return new Promise<{ available: boolean; reason: string; writes: number | null; unresolved: number }>(resolve => {
    const args = ["-w", "-f", "filesys", "-t", String(seconds), ...pids.map(String)];
    // Opt-in tracer elevation only; the App and Agent remain unprivileged.
    const sudo = process.env.BUTLER_P0_FS_USAGE_SUDO === "1";
    const child = spawn(sudo ? "/usr/bin/sudo" : "/usr/bin/fs_usage", sudo ? ["-n", "/usr/bin/fs_usage", ...args] : args, { stdio: ["ignore", "pipe", "pipe"] });
    let pending = "", writes = 0, unresolved = 0, denied = false;
    child.stdout.on("data", bytes => {
      pending += String(bytes);
      const lines = pending.split("\n"); pending = lines.pop() || "";
      for (const line of lines) {
        if (!/\b(write|pwrite|WrData|rename|unlink|mkdir|truncate)\b/iu.test(line)) continue;
        // All resolved writes by the owned processes count, including the
        // Electron profile/Partitions outside BUTLER_DATA.
        if (line.includes("/")) writes++;
        else unresolved++;
      }
    });
    child.stderr.on("data", bytes => { denied ||= /root|permission|privilege|password/iu.test(String(bytes)); });
    const timer = setTimeout(() => child.kill("SIGTERM"), (seconds + 5) * 1000);
    child.once("error", () => { clearTimeout(timer); resolve({ available: false, reason: "fs_usage unavailable", writes: null, unresolved }); });
    child.once("exit", code => {
      clearTimeout(timer);
      const available = code === 0 && !denied && unresolved === 0;
      resolve({ available, reason: denied ? "fs_usage requires root" : code !== 0 ? "fs_usage failed" : unresolved ? "Write records without resolved paths" : "Owned process filesystem trace", writes: available ? writes : null, unresolved });
    });
  });
}
