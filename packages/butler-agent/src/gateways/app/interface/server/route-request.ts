import { apiError } from "../protocol/app-protocol.ts";
import { serveStatic } from "./static-ui.ts";
import { enforceLocalAuth } from "./local-auth.ts";
import { json } from "./responses.ts";
import type { AppRouteContext, AppRouteHandler, AppRouteRequest } from "./server-types.ts";
import { handleAutomationWorkerRoutes } from "./routes/automation-worker-routes.ts";
import { handleAuthorityRoutes } from "./routes/authority-routes.ts";
import { handleMessageRoutes } from "./routes/message-routes.ts";
import { handlePersonalizationRoutes } from "./routes/personalization-routes.ts";
import { handleProjectSessionRoutes } from "./routes/project-session-routes.ts";
import { handleRuntimeRoutes } from "./routes/runtime-routes.ts";
import { handleSettingsRoutes } from "./routes/settings-routes.ts";

const ROUTE_HANDLERS: AppRouteHandler[] = [
  handleRuntimeRoutes,
  handleSettingsRoutes,
  handlePersonalizationRoutes,
  handleProjectSessionRoutes,
  handleMessageRoutes,
  handleAutomationWorkerRoutes,
  handleAuthorityRoutes,
];

export async function routeRequest(input: AppRouteRequest): Promise<Response> {
  const url = new URL(input.request.url);
  enforceLocalAuth(input.request, input.localAuth);

  const context: AppRouteContext = { ...input, url };
  await refreshDueAutomationsForReadRoutes(context);

  for (const handler of ROUTE_HANDLERS) {
    const response = await handler(context);
    if (response) return response;
  }
  if (input.request.method === "GET") {
    return await serveStatic(input.uiRoot, url.pathname);
  }
  return json(apiError("not_found", "Route not found."), 404);
}

async function refreshDueAutomationsForReadRoutes(
  input: AppRouteContext,
): Promise<void> {
  if (
    input.request.method === "GET" &&
    (input.url.pathname === "/automations" || input.url.pathname.endsWith("/runs"))
  ) {
    await input.store.dispatchDueAutomations(input.responder, {
      responderTimeoutMs: input.responderTimeoutMs,
      deferResponderTurns: true,
    });
  }
}
