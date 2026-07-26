import { apiEnvelope } from "../../protocol/app-protocol.ts";
import { json, RequestError } from "../responses.ts";
import type { AppRouteContext } from "../server-types.ts";

const OPERATION_OUTPUT_PATH =
  /^\/turns\/([^/]+)\/operations\/([^/]+)\/output$/u;

export function handleOperationOutputRoutes(
  input: AppRouteContext,
): Response | null {
  if (input.request.method !== "GET") return null;
  const match = input.url.pathname.match(OPERATION_OUTPUT_PATH);
  if (!match) return null;
  const turnId = decodeURIComponent(match[1]!);
  const requestId = decodeURIComponent(match[2]!);
  const resultId = input.url.searchParams.get("result_id");
  if (!resultId) {
    throw new RequestError(400, "result_required", "Result id is required.");
  }
  const byteStart = nonNegativeOffset(input.url.searchParams.get("offset"));
  const output = input.store.getOperationOutput({
    turnId,
    requestId,
    resultId,
    byteStart,
  });
  if (!output) {
    throw new RequestError(
      404,
      "operation_output_not_found",
      "Operation output is not available for this turn.",
    );
  }
  return json(apiEnvelope(output));
}

function nonNegativeOffset(value: string | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RequestError(400, "offset_invalid", "Offset must be non-negative.");
  }
  return parsed;
}
