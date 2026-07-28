import type { AppMessageResponder } from "../gateways/app/application/store/app-server-store.ts";
import {
  createAppServerFromTestComposition,
  type AppServerHandle,
  type CreateAppServerOptions,
} from "../gateways/app/interface/server/create-app-server.ts";

export type CreateTestAppServerOptions = CreateAppServerOptions & {
  responder?: AppMessageResponder;
  responderTimeoutMs?: number;
};

export function createTestAppServer(
  options: CreateTestAppServerOptions = {},
): AppServerHandle {
  const { responder, responderTimeoutMs, ...serverOptions } = options;
  return createAppServerFromTestComposition(serverOptions, {
    responder,
    responderTimeoutMs,
  });
}
