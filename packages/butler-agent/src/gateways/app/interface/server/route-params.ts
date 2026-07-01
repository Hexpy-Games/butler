export function maxCursor(
  values: Array<number | undefined>,
  fallback: number,
): number {
  return values.reduce<number>((max, value) => {
    const cursor = Number(value ?? 0);
    return Number.isFinite(cursor) && cursor > max ? cursor : max;
  }, fallback);
}

export function paginationFromSearchParams(
  searchParams: URLSearchParams,
): { limit?: number; offset?: number } {
  return {
    limit: parsePositiveInteger(searchParams.get("limit")),
    offset: parseNonNegativeInteger(searchParams.get("offset")),
  };
}

export function usageMonitorFromSearchParams(
  searchParams: URLSearchParams,
): { sessionId?: string; sinceTs?: number | null } {
  const sinceHours = parsePositiveNumber(
    searchParams.get("since_hours") ?? searchParams.get("sinceHours"),
  );
  const sessionId =
    searchParams.get("session_id") ?? searchParams.get("sessionId") ?? "";
  return {
    sessionId: sessionId.trim() || undefined,
    sinceTs:
      sinceHours === undefined
        ? null
        : Date.now() - sinceHours * 60 * 60 * 1000,
  };
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.floor(parsed);
}

function parsePositiveNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function parseNonNegativeInteger(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}
