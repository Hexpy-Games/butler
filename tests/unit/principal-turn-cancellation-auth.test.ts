import { expect, test } from "bun:test";
import {
  createWindowsCancellationControl,
  WindowsCancellationAuthenticator,
  windowsCancellationPipeName,
} from "../../packages/butler-agent/src/agent/turn/principal-turn-cancellation-auth.ts";

const request = {
  version: 1 as const,
  action: "cancel_execution" as const,
  turn_id: "turn-1",
  queue_id: "queue-1",
  dispatch_claim_id: "claim-1",
};
const response = { version: 1 as const, outcome: "signal_dispatched" as const };

test("Windows cancellation authentication accepts one exact generation and identity", () => {
  const control = createWindowsCancellationControl("C:\\Users\\연우\\Butler Data", {
    generateSecret: () => Buffer.alloc(32, 7),
    generateGeneration: () => "generation-1234567890",
  });
  const client = new WindowsCancellationAuthenticator(control, () => 1_000, () => "a".repeat(32));
  const server = new WindowsCancellationAuthenticator(control, () => 1_000);
  const frame = client.createRequest(request);
  const signedResponse = server.acceptRequest(frame, (value) => {
    expect(value).toEqual(request);
    return response;
  });

  expect(control.pipe_path).toStartWith("\\\\.\\pipe\\butler-cancel-");
  expect(windowsCancellationPipeName(control)).toStartWith("butler-cancel-");
  expect(signedResponse).not.toBeNull();
  expect(client.acceptResponse(frame, signedResponse!)).toEqual(response);
});

test("Windows cancellation authentication rejects replay secret generation and age failures", () => {
  const control = createWindowsCancellationControl("C:\\Butler", {
    generateSecret: () => Buffer.alloc(32, 1),
    generateGeneration: () => "generation-1234567890",
  });
  const server = new WindowsCancellationAuthenticator(control, () => 10_000);
  const client = new WindowsCancellationAuthenticator(control, () => 10_000, () => "b".repeat(32));
  const exact = client.createRequest(request);

  expect(server.acceptRequest(exact, () => response)).not.toBeNull();
  expect(server.acceptRequest(exact, () => response)).toBeNull();

  const wrongSecret = {
    ...control,
    secret: Buffer.alloc(32, 2).toString("base64"),
  };
  const wrongSecretFrame = new WindowsCancellationAuthenticator(
    wrongSecret,
    () => 10_000,
    () => "c".repeat(32),
  ).createRequest(request);
  expect(server.acceptRequest(wrongSecretFrame, () => response)).toBeNull();

  const wrongGenerationFrame = new WindowsCancellationAuthenticator(
    { ...control, generation: "generation-other-1234" },
    () => 10_000,
    () => "d".repeat(32),
  ).createRequest(request);
  expect(server.acceptRequest(wrongGenerationFrame, () => response)).toBeNull();

  const staleFrame = new WindowsCancellationAuthenticator(
    control,
    () => 10_000 - 30_001,
    () => "e".repeat(32),
  ).createRequest(request);
  expect(server.acceptRequest(staleFrame, () => response)).toBeNull();
});

test("Windows cancellation authentication binds response to request nonce", () => {
  const control = createWindowsCancellationControl("C:\\Butler", {
    generateSecret: () => Buffer.alloc(32, 3),
    generateGeneration: () => "generation-1234567890",
  });
  const clientA = new WindowsCancellationAuthenticator(control, () => 1_000, () => "f".repeat(32));
  const clientB = new WindowsCancellationAuthenticator(control, () => 1_000, () => "0".repeat(32));
  const server = new WindowsCancellationAuthenticator(control, () => 1_000);
  const frameA = clientA.createRequest(request);
  const frameB = clientB.createRequest(request);
  const responseA = server.acceptRequest(frameA, () => response)!;

  expect(clientA.acceptResponse(frameA, responseA)).toEqual(response);
  expect(clientB.acceptResponse(frameB, responseA)).toBeNull();
});
