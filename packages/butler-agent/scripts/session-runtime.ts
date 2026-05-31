#!/usr/bin/env bun
import { cwd } from "process";
import { registerRuntimeSession, transitionRuntimeSession } from "../src/test-support/harness/session-runtime.ts";

function usage(): never {
  console.error(
    "Usage:\n" +
      "  $BUTLER_BUN run packages/butler-agent/scripts/session-runtime.ts register <role> <session_id> [workspace_path]\n" +
      "  $BUTLER_BUN run packages/butler-agent/scripts/session-runtime.ts transition <session_id> <state> [reason] [role]\n",
  );
  process.exit(1);
}

const [, , command, ...rest] = process.argv;
if (!command) usage();

if (command === "register") {
  const [role, sessionId, workspacePath] = rest;
  if ((role !== "butler" && role !== "steward") || !sessionId) usage();
  const stored = registerRuntimeSession({
    role,
    sessionId,
    workspacePath: workspacePath || cwd(),
    source: "session-start-hook",
  });
  console.log(stored.sessionId);
  process.exit(0);
}

if (command === "transition") {
  const [sessionId, state, reason, role] = rest;
  if (
    !sessionId ||
    (state !== "active" && state !== "closing" && state !== "closed" && state !== "crashed")
  ) {
    usage();
  }
  transitionRuntimeSession({
    sessionId,
    state,
    reason,
    role: role === "butler" || role === "steward" ? role : undefined,
    source: "lifecycle-script",
  });
  console.log(sessionId);
  process.exit(0);
}

usage();
