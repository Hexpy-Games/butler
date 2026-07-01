import {
  APP_PROTOCOL_VERSION,
  apiEnvelope,
  isUpdateApplyRequest,
  isUpdateCheckRequest,
  type AppInfoView,
  type EventReplayView,
  type HealthView,
  type SystemEventListView,
  type UpdateApplyResult,
  type UpdateStatusView,
  type UsageMonitorView,
} from "../../protocol/app-protocol.ts";
import { liveEventsResponse } from "../live-events.ts";
import { paginationFromSearchParams, usageMonitorFromSearchParams } from "../route-params.ts";
import { json, parseJson, RequestError } from "../responses.ts";

import type { AppRouteContext } from "../server-types.ts";

export async function handleRuntimeRoutes(
  input: AppRouteContext,
): Promise<Response | null> {
  const { url } = input;
  if (input.request.method === "GET" && url.pathname === "/health") {
    return json(
      apiEnvelope<HealthView>({
        ok: true,
        service: "butler-app-server",
        protocol_version: APP_PROTOCOL_VERSION,
      }),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/app-info") {
    return json(apiEnvelope<AppInfoView>(input.store.getAppInfo()));
  }
  if (input.request.method === "GET" && url.pathname === "/updates") {
    return json(apiEnvelope<UpdateStatusView>(await input.store.getUpdateStatus()));
  }
  if (input.request.method === "POST" && url.pathname === "/updates/check") {
    const body = await parseJson(input.request);
    if (!isUpdateCheckRequest(body)) {
      throw new RequestError(
        400,
        "invalid_update_check",
        "Update check request contains unsupported fields.",
      );
    }
    return json(apiEnvelope<UpdateStatusView>(await input.store.checkUpdates(body ?? {})));
  }
  if (input.request.method === "POST" && url.pathname === "/updates/apply") {
    const body = await parseJson(input.request);
    if (!isUpdateApplyRequest(body)) {
      throw new RequestError(
        400,
        "invalid_update_apply",
        "Update apply request requires a supported component.",
      );
    }
    return json(apiEnvelope<UpdateApplyResult>(await input.store.applyUpdate(body)));
  }
  if (input.request.method === "GET" && url.pathname === "/system-events") {
    return json(
      apiEnvelope<SystemEventListView>(
        input.store.listSystemEvents(paginationFromSearchParams(url.searchParams)),
      ),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/usage-monitor") {
    return json(
      apiEnvelope<UsageMonitorView>(
        input.store.getUsageMonitor(usageMonitorFromSearchParams(url.searchParams)),
      ),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/events") {
    const cursor = Number(url.searchParams.get("cursor") ?? "0");
    const events = input.store.replayEvents(
      Number.isFinite(cursor) ? cursor : 0,
    );
    return json(
      apiEnvelope<EventReplayView>({
        events,
        next_cursor:
          events.at(-1)?.id ?? (Number.isFinite(cursor) ? cursor : 0),
      }),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/events/live") {
    const cursor = Number(url.searchParams.get("cursor") ?? "0");
    return liveEventsResponse(
      input.store,
      Number.isFinite(cursor) ? cursor : 0,
    );
  }
  return null;
}
