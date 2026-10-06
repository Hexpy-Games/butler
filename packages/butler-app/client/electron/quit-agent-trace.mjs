import { spawn } from "node:child_process";

// Decode only structured phase lines, never expose arbitrary service output to UI.
export function spawnTracedAgent(command, args, options, onPhase) {
  if (!Array.isArray(options.stdio) || options.stdio[0] !== "pipe") return spawn(command, args, options);
  const child = spawn(command, args, { ...options, stdio: ["pipe", "inherit", "pipe"] });
  let pending = "";
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    pending += String(chunk);
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const match = line.match(/\[native-shutdown\].*phase=([a-z_]+) edge=(begin|end|event)/u);
      if (match) onPhase(match[1], match[2]);
    }
    // Bound a malformed log line; normal phase lines are <256 bytes.
    if (pending.length > 4096) pending = "";
  });
  return child;
}
