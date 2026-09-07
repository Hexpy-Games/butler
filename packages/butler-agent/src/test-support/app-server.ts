import type { AppMessageResponder } from "../gateways/app/application/store/app-server-store.ts";
import {
  createAppServerFromTestComposition,
  type AppServerHandle,
  type CreateAppServerOptions,
} from "../gateways/app/interface/server/create-app-server.ts";

export type CreateTestAppServerOptions = CreateAppServerOptions & {
  responder?: AppMessageResponder;
  responderTimeoutMs?: number;
  serverIdleTimeoutSeconds?: number;
  /** Unit fixtures must opt in before invoking the real optional grouping model. */
  enableSmartGrouping?: boolean;
};

export function createTestAppServer(
  options: CreateTestAppServerOptions = {},
): AppServerHandle {
  const {
    responder,
    responderTimeoutMs,
    serverIdleTimeoutSeconds,
    enableSmartGrouping = false,
    ...serverOptions
  } = options;
  const server = createAppServerFromTestComposition(serverOptions, {
    responder,
    responderTimeoutMs,
    serverIdleTimeoutSeconds,
  });
  if (!enableSmartGrouping) server.store.updateSettings({ smart_grouping_enabled: false });
  return server;
}
