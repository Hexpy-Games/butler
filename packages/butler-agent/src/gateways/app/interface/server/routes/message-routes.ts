import { handleMessageFileRoutes } from "./message-file-routes.ts";
import { handleSessionFeedRoutes } from "./session-feed-routes.ts";
import { handleSessionQueueRoutes } from "./session-queue-routes.ts";
import { handleSessionViewRoutes } from "./session-view-routes.ts";
import type { AppRouteContext } from "../server-types.ts";

const MESSAGE_ROUTE_HANDLERS = [
  handleMessageFileRoutes,
  handleSessionFeedRoutes,
  handleSessionQueueRoutes,
  handleSessionViewRoutes,
] as const;

export async function handleMessageRoutes(
  input: AppRouteContext,
): Promise<Response | null> {
  for (const handleRoute of MESSAGE_ROUTE_HANDLERS) {
    const response = await handleRoute(input);
    if (response) return response;
  }
  return null;
}
