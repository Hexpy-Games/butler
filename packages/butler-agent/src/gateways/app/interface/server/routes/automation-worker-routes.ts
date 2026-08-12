import {
  apiEnvelope,
  isCreateAutomationRequest,
  type AutomationDetailView,
  type AutomationListView,
  type AutomationMutationResult,
  type AutomationRunListView,
  type AutomationRunResult,
  type WorkerActivityControlRequest,
  type WorkerActivityControlResult,
  type WorkerActivityListView,
  type WorkerActivitySummary,
} from "../../protocol/app-protocol.ts";
import { json, parseJson, RequestError } from "../responses.ts";

import type { AppRouteContext } from "../server-types.ts";

export async function handleAutomationWorkerRoutes(
  input: AppRouteContext,
): Promise<Response | null> {
  const { url } = input;
  if (input.request.method === "GET" && url.pathname === "/automations") {
    return json(
      apiEnvelope<AutomationListView>(
        input.store.listAutomations({
          targetSessionId:
            url.searchParams.get("target_session_id") ?? undefined,
        }),
      ),
    );
  }
  if (input.request.method === "POST" && url.pathname === "/automations") {
    const body = await parseJson(input.request);
    if (!isCreateAutomationRequest(body)) {
      throw new RequestError(
        400,
        "invalid_request",
        "Automation title, prompt, target, and interval are required.",
      );
    }
    return json(
      apiEnvelope<AutomationMutationResult>(input.store.createAutomation(body)),
      201,
    );
  }
  if (
    input.request.method === "POST" &&
    url.pathname === "/automations/dispatch-due"
  ) {
    return json(
      apiEnvelope(
        await input.store.dispatchDueAutomations(input.responder, {
          responderTimeoutMs: input.responderTimeoutMs,
          deferResponderTurns: true,
        }),
      ),
      202,
    );
  }
  const automationMatch = url.pathname.match(/^\/automations\/([^/]+)$/u);
  if (input.request.method === "GET" && automationMatch) {
    return json(
      apiEnvelope<AutomationDetailView>(
        input.store.getAutomation(decodeURIComponent(automationMatch[1]!)),
      ),
    );
  }
  if (input.request.method === "PATCH" && automationMatch) {
    const body = await parseJson(input.request);
    return json(
      apiEnvelope<AutomationMutationResult>(
        input.store.updateAutomation(
          decodeURIComponent(automationMatch[1]!),
          body && typeof body === "object" ? body : {},
        ),
      ),
    );
  }
  if (input.request.method === "DELETE" && automationMatch) {
    return json(
      apiEnvelope<AutomationMutationResult>(
        input.store.deleteAutomation(decodeURIComponent(automationMatch[1]!)),
      ),
    );
  }
  const automationActionMatch =
    input.request.method === "POST"
      ? url.pathname.match(/^\/automations\/([^/]+)\/(run|pause|resume)$/u)
      : null;
  if (automationActionMatch) {
    const automationId = decodeURIComponent(automationActionMatch[1]!);
    const action = automationActionMatch[2];
    if (action === "run") {
      return json(
        apiEnvelope<AutomationRunResult>(
          await input.store.runAutomationNow(automationId, input.responder, {
            responderTimeoutMs: input.responderTimeoutMs,
            deferResponderTurns: true,
          }),
        ),
        202,
      );
    }
    if (action === "pause") {
      return json(
        apiEnvelope<AutomationMutationResult>(
          input.store.pauseAutomation(automationId),
        ),
        202,
      );
    }
    return json(
      apiEnvelope<AutomationMutationResult>(
        input.store.resumeAutomation(automationId),
      ),
      202,
    );
  }
  const automationRunsMatch =
    input.request.method === "GET"
      ? url.pathname.match(/^\/automations\/([^/]+)\/runs$/u)
      : null;
  if (automationRunsMatch) {
    return json(
      apiEnvelope<AutomationRunListView>(
        input.store.listAutomationRuns(
          decodeURIComponent(automationRunsMatch[1]!),
        ),
      ),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/worker-activity") {
    return json(
      apiEnvelope<WorkerActivityListView>(
        input.store.listWorkerActivity({
          includeHistory: url.searchParams.get("include_history") === "true",
          limit: boundedPageParam(url.searchParams.get("limit"), 200),
          offset: boundedPageParam(url.searchParams.get("offset"), 0, 0),
          cursor: url.searchParams.get("cursor") ?? undefined,
        }),
      ),
    );
  }
  const workerActivityMatch = url.pathname.match(
    /^\/worker-activity\/([^/]+)$/u,
  );
  if (input.request.method === "GET" && workerActivityMatch) {
    return json(
      apiEnvelope<WorkerActivitySummary>(
        input.store.getWorkerActivity(
          decodeURIComponent(workerActivityMatch[1]!),
        ),
      ),
    );
  }
  const workerControlMatch =
    input.request.method === "POST"
      ? url.pathname.match(/^\/worker-activity\/([^/]+)\/control$/u)
      : null;
  if (workerControlMatch) {
    const body = await parseJson(input.request);
    return json(
      apiEnvelope<WorkerActivityControlResult>(
        input.store.controlWorkerActivity(
          decodeURIComponent(workerControlMatch[1]!),
          (body && typeof body === "object"
            ? body
            : { action: "cancel" }) as WorkerActivityControlRequest,
        ),
      ),
      202,
    );
  }
  return null;
}

function boundedPageParam(
  value: string | null,
  fallback: number,
  minimum = 1,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(200, Math.floor(parsed)))
    : fallback;
}
