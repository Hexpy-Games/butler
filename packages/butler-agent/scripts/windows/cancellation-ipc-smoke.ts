import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsProcessHostExecutable } from "../../src/runtime/command/powershell-command-adapter.ts";
import {
  WindowsCancellationAuthenticator,
  type WindowsCancellationControl,
} from "../../src/agent/turn/principal-turn-cancellation-auth.ts";
import {
  startPrincipalTurnCancellationServer,
  type CancelExecutionRequest,
  type CancelExecutionResponse,
} from "../../src/agent/turn/principal-turn-cancellation-control.ts";
import {
  recordPrincipalTurnCancellation,
  registerPrincipalTurnAbortController,
} from "../../src/agent/turn/principal-turn-cancellation-registry.ts";

if (process.platform !== "win32") {
  throw new Error("Windows cancellation IPC smoke requires win32");
}

const butlerData = join(tmpdir(), "Butler cancellation 한글 smoke");
rmSync(butlerData, { recursive: true, force: true });
mkdirSync(butlerData, { recursive: true });
const turnId = "turn-windows-cancel";
const request: CancelExecutionRequest = {
  version: 1,
  action: "cancel_execution",
  turn_id: turnId,
  queue_id: "queue-windows-cancel",
  dispatch_claim_id: "claim-windows-cancel",
};
const controller = new AbortController();
const unregister = registerPrincipalTurnAbortController({
  butlerData,
  turnId,
  queueId: request.queue_id,
  dispatchClaimId: request.dispatch_claim_id,
  controller,
});
recordPrincipalTurnCancellation({ butlerData, turnId });

const server = await startPrincipalTurnCancellationServer(butlerData);
const controlPath = join(butlerData, "runtime", "cancellation", "control.json");
try {
  const control = JSON.parse(
    readFileSync(controlPath, "utf8"),
  ) as WindowsCancellationControl;
  const client = new WindowsCancellationAuthenticator<
    CancelExecutionRequest,
    CancelExecutionResponse
  >(control);
  const standardUser = isMediumIntegrityProcess();
  const separateOwnershipProof = process.env.BUTLER_WINDOWS_DACL_SEPARATELY_VERIFIED === "1";
  const ownershipProbe = separateOwnershipProof
    ? {
        rejected: true,
        evidence: {
          userCreated: false,
          launchStatus: null,
          result: "separately-verified" as string | null,
        },
      }
    : await verifyOtherUserDenied(
        control.pipe_path.slice("\\\\.\\pipe\\".length),
      );
  const unauthorizedUserRejected = ownershipProbe.rejected;

  const staleIdentityFrame = client.createRequest({
    ...request,
    dispatch_claim_id: "claim-stale",
  });
  const staleIdentityResponse = await sendFrame(control.pipe_path, staleIdentityFrame);
  const staleIdentity = client.acceptResponse(
    staleIdentityFrame,
    staleIdentityResponse ?? "{}",
  );

  const wrongSecret = new WindowsCancellationAuthenticator<
    CancelExecutionRequest,
    CancelExecutionResponse
  >({ ...control, secret: Buffer.alloc(32, 9).toString("base64") });
  const wrongSecretRejected =
    (await sendFrame(control.pipe_path, wrongSecret.createRequest(request))) === "{}";

  const wrongGeneration = new WindowsCancellationAuthenticator<
    CancelExecutionRequest,
    CancelExecutionResponse
  >({ ...control, generation: "generation-wrong-1234" });
  const wrongGenerationRejected =
    (await sendFrame(control.pipe_path, wrongGeneration.createRequest(request))) === "{}";

  const exactFrame = client.createRequest(request);
  const exactResponseFrame = await sendFrame(control.pipe_path, exactFrame);
  const exactResponse = client.acceptResponse(exactFrame, exactResponseFrame ?? "{}");
  const replayRejected = (await sendFrame(control.pipe_path, exactFrame)) === "{}";
  const oversizedRejected =
    (await sendFrame(control.pipe_path, "x".repeat(5_000))) === "{}";

  const result = {
    ok:
      server.transport === "windows-named-pipe" &&
      unauthorizedUserRejected &&
      staleIdentity?.outcome === "execution_identity_mismatch" &&
      wrongSecretRejected &&
      wrongGenerationRejected &&
      ["signal_dispatched", "already_settled"].includes(exactResponse?.outcome ?? "") &&
      controller.signal.aborted &&
      replayRejected &&
      oversizedRejected,
    platform: process.platform,
    transport: server.transport,
    explicitUserSidDacl: unauthorizedUserRejected,
    unauthorizedUserRejected,
    ownershipProbe: ownershipProbe.evidence,
    standardUser,
    authenticated: exactResponse !== null,
    exactIdentity: controller.signal.aborted,
    staleIdentityRejected: staleIdentity?.outcome === "execution_identity_mismatch",
    wrongSecretRejected,
    wrongGenerationRejected,
    replayRejected,
    oversizedRejected,
    boundedFrameBytes: 4_096,
    rawTextIncluded: false,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
} finally {
  unregister();
  await server.close();
  const controlRemoved = !existsSync(controlPath);
  if (!controlRemoved) process.exitCode = 1;
  rmSync(butlerData, { recursive: true, force: true });
}

function isMediumIntegrityProcess(): boolean {
  const result = spawnSync(
    "whoami.exe",
    ["/groups", "/fo", "csv", "/nh"],
    { encoding: "utf8", windowsHide: true },
  );
  return result.status === 0 && result.stdout.includes("S-1-16-8192");
}

async function verifyOtherUserDenied(pipeName: string): Promise<{
  rejected: boolean;
  evidence: { userCreated: boolean; launchStatus: number | null; result: string | null };
}> {
  const username = `bt_ipc_${process.pid}`.slice(0, 20);
  const password = `Bt!1${randomBytes(4).toString("hex")}`;
  const created = spawnSync(
    "net.exe",
    ["user", username, password, "/add", "/expires:never", "/passwordchg:no"],
    { stdio: "ignore", windowsHide: true },
  );
  if (created.status !== 0) {
    return {
      rejected: false,
      evidence: { userCreated: false, launchStatus: null, result: null },
    };
  }
  try {
    const probe = spawnSync(
      windowsProcessHostExecutable(),
      [
        "--pipe-user-probe",
        pipeName,
        username,
        password,
      ],
      { stdio: "ignore", windowsHide: true, timeout: 5_000 },
    );
    const result = probe.status === 20
      ? "denied"
      : probe.status === 10
      ? "connected"
      : null;
    return {
      rejected: probe.status === 20 && result === "denied",
      evidence: {
        userCreated: true,
        launchStatus: probe.status,
        result,
      },
    };
  } finally {
    spawnSync("net.exe", ["user", username, "/delete"], {
      stdio: "ignore",
      windowsHide: true,
    });
  }
}

async function sendFrame(pipePath: string, frame: string): Promise<string | null> {
  return await new Promise((resolve) => {
    const socket = new Socket();
    let response = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2_000, () => finish(null));
    socket.once("connect", () => socket.write(`${frame}\n`));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      const newline = response.indexOf("\n");
      if (newline >= 0) finish(response.slice(0, newline));
    });
    socket.once("error", () => finish(null));
    socket.connect(pipePath);
  });
}
