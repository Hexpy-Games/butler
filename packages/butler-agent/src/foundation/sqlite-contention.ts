const SQLITE_CONTENTION_CODES = new Set([
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "5",
  "6",
]);

const SQLITE_CONTENTION_MESSAGES = new Set([
  "database is locked",
  "database table is locked",
  "database schema is locked",
]);

type ErrorRecord = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  errno?: unknown;
  cause?: unknown;
  errors?: unknown;
};

export function isSqliteContention(error: unknown): boolean {
  return findSqliteContention(error, new Set());
}

function findSqliteContention(
  error: unknown,
  visited: Set<object>,
): boolean {
  if (!error || typeof error !== "object" || visited.has(error)) return false;
  visited.add(error);
  const candidate = error as ErrorRecord;
  if (hasContentionCode(candidate.code) || hasContentionCode(candidate.errno)) {
    return true;
  }
  if (
    candidate.name === "SQLiteError" &&
    typeof candidate.message === "string" &&
    SQLITE_CONTENTION_MESSAGES.has(candidate.message)
  ) {
    return true;
  }
  if (findSqliteContention(candidate.cause, visited)) return true;
  return Array.isArray(candidate.errors) &&
    candidate.errors.some((nested) => findSqliteContention(nested, visited));
}

function hasContentionCode(value: unknown): boolean {
  return (
    typeof value === "string" || typeof value === "number"
  ) && SQLITE_CONTENTION_CODES.has(String(value));
}
