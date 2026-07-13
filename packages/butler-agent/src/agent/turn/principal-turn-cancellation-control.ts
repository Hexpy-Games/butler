import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createConnection, createServer, Socket, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  abortPrincipalTurnExecution,
  markPrincipalTurnCancellationDelivery,
  principalTurnCancellationRecorded,
  type PrincipalTurnExecutionIdentity,
} from "./principal-turn-cancellation-registry.ts";

const MAX_CANCEL_FRAME_BYTES = 4_096;
const CANCEL_REQUEST_TIMEOUT_MS = 500;

export interface CancelExecutionRequest {
  version: 1;
  action: "cancel_execution";
  turn_id: string;
  queue_id: string;
  dispatch_claim_id: string;
}

export interface CancelExecutionResponse {
  version: 1;
  outcome:
    | "signal_dispatched"
    | "already_settled"
    | "decision_not_cancelled"
    | "execution_identity_mismatch";
}

export interface PrincipalTurnCancellationServer {
  socketPath: string;
  close(): Promise<void>;
}

export function principalTurnCancellationSocketPath(butlerData: string): string {
  const rootHash = createHash("sha256")
    .update(resolve(butlerData))
    .digest("hex")
    .slice(0, 24);
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return join(tmpdir(), `butler-${uid}`, `cancel-${rootHash}.sock`);
}

export async function startPrincipalTurnCancellationServer(
  butlerData: string,
): Promise<PrincipalTurnCancellationServer> {
  const root = resolve(butlerData);
  const socketPath = principalTurnCancellationSocketPath(root);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  assertPrivateSocketDirectory(dirname(socketPath));
  await prepareSocketPath(socketPath);

  const server = createServer((socket) => {
    let frame = "";
    let handled = false;
    socket.setTimeout(CANCEL_REQUEST_TIMEOUT_MS, () => socket.destroy());
    socket.on("data", (chunk) => {
      frame += chunk.toString("utf8");
      if (Buffer.byteLength(frame) > MAX_CANCEL_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      const newline = frame.indexOf("\n");
      if (newline < 0 || handled) return;
      handled = true;
      const response = handleCancelExecutionFrame(root, frame.slice(0, newline));
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  server.maxConnections = 32;
  await listenUnix(server, socketPath);
  chmodSync(socketPath, 0o600);
  return {
    socketPath,
    close: async () => {
      await closeServer(server);
      rmSync(socketPath, { force: true });
    },
  };
}

export async function signalPrincipalTurnCancellation(input: {
  butlerData: string;
  turnId: string;
}): Promise<CancelExecutionResponse | null> {
  const identity = activePrincipalTurnExecutionIdentity(input);
  if (!identity) return null;
  return await sendCancelExecutionRequest(input.butlerData, {
    version: 1,
    action: "cancel_execution",
    turn_id: identity.turnId,
    queue_id: identity.queueId,
    dispatch_claim_id: identity.dispatchClaimId,
  });
}

export async function sendCancelExecutionRequest(
  butlerData: string,
  request: CancelExecutionRequest,
): Promise<CancelExecutionResponse | null> {
  const socketPath = principalTurnCancellationSocketPath(butlerData);
  return await new Promise((resolveResponse) => {
    let settled = false;
    let responseFrame = "";
    const finish = (response: CancelExecutionResponse | null) => {
      if (settled) return;
      settled = true;
      resolveResponse(response);
    };
    const socket = new Socket();
    socket.setTimeout(CANCEL_REQUEST_TIMEOUT_MS, () => {
      socket.destroy();
      finish(null);
    });
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      responseFrame += chunk.toString("utf8");
      if (Buffer.byteLength(responseFrame) > MAX_CANCEL_FRAME_BYTES) {
        socket.destroy();
        finish(null);
        return;
      }
      const newline = responseFrame.indexOf("\n");
      if (newline < 0) return;
      finish(parseCancelExecutionResponse(responseFrame.slice(0, newline)));
      socket.end();
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
    socket.connect(socketPath);
  });
}

function handleCancelExecutionFrame(
  butlerData: string,
  frame: string,
): CancelExecutionResponse {
  const request = parseCancelExecutionRequest(frame);
  if (!request) {
    return { version: 1, outcome: "execution_identity_mismatch" };
  }
  if (
    !principalTurnCancellationRecorded({
      butlerData,
      turnId: request.turn_id,
    })
  ) {
    return { version: 1, outcome: "decision_not_cancelled" };
  }
  const identity = {
    butlerData,
    turnId: request.turn_id,
    queueId: request.queue_id,
    dispatchClaimId: request.dispatch_claim_id,
  };
  const outcome = abortPrincipalTurnExecution(identity);
  if (outcome === "signal_dispatched" || outcome === "already_settled") {
    markPrincipalTurnCancellationDelivery(identity, "accepted");
  }
  return {
    version: 1,
    outcome,
  };
}

export function activePrincipalTurnExecutionIdentity(input: {
  butlerData: string;
  turnId: string;
}): PrincipalTurnExecutionIdentity | null {
  const processingDir = join(
    resolve(input.butlerData),
    "runtime",
    "inbound-events",
    "processing",
  );
  if (!existsSync(processingDir)) return null;
  for (const name of readdirSync(processingDir).filter((item) => item.endsWith(".json"))) {
    try {
      const record = JSON.parse(
        readFileSync(join(processingDir, name), "utf8"),
      ) as Record<string, any>;
      if (record.envelope?.routingHints?.turnId !== input.turnId) continue;
      const queueId = requiredToken(record.queueId);
      const dispatchClaimId = requiredToken(record.processing?.claimId);
      if (!queueId || !dispatchClaimId) continue;
      return {
        butlerData: input.butlerData,
        turnId: input.turnId,
        queueId,
        dispatchClaimId,
      };
    } catch {
      continue;
    }
  }
  return null;
}

function parseCancelExecutionRequest(frame: string): CancelExecutionRequest | null {
  try {
    const value = JSON.parse(frame) as Record<string, unknown>;
    const turnId = requiredToken(value.turn_id);
    const queueId = requiredToken(value.queue_id);
    const dispatchClaimId = requiredToken(value.dispatch_claim_id);
    if (
      value.version !== 1 ||
      value.action !== "cancel_execution" ||
      !turnId ||
      !queueId ||
      !dispatchClaimId
    ) {
      return null;
    }
    return {
      version: 1,
      action: "cancel_execution",
      turn_id: turnId,
      queue_id: queueId,
      dispatch_claim_id: dispatchClaimId,
    };
  } catch {
    return null;
  }
}

function parseCancelExecutionResponse(frame: string): CancelExecutionResponse | null {
  try {
    const value = JSON.parse(frame) as CancelExecutionResponse;
    if (
      value.version !== 1 ||
      ![
        "signal_dispatched",
        "already_settled",
        "decision_not_cancelled",
        "execution_identity_mismatch",
      ].includes(value.outcome)
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function assertPrivateSocketDirectory(path: string): void {
  chmodSync(path, 0o700);
  const stat = statSync(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat.isDirectory() || (uid !== null && stat.uid !== uid)) {
    throw new Error("principal_turn_cancellation_socket_directory_unsafe");
  }
}

function requiredToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  return token && token.length <= 200 ? token : null;
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return;
  const live = await new Promise<boolean>((resolveProbe) => {
    const socket = createConnection(socketPath);
    const finish = (value: boolean) => {
      socket.destroy();
      resolveProbe(value);
    };
    socket.setTimeout(100, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
  if (live) {
    throw new Error("principal_turn_cancellation_listener_already_running");
  }
  rmSync(socketPath, { force: true });
}

async function listenUnix(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}
