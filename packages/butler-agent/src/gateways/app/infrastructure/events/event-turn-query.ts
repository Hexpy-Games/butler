import type { Database } from "bun:sqlite";

export function eventTurnMatchSql(
  db: Database,
  options: {
    parameterIndex?: number;
    legacyPayload?: "all" | "direct";
  } = {},
): string {
  const indexed = db.query<{ name: string }, []>(`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name = 'events_turn_id_idx'
  `).get();
  const directParameter = options.parameterIndex
    ? `?${options.parameterIndex}`
    : "?";
  if (indexed) return `turn_id = ${directParameter}`;
  if (options.legacyPayload !== "all") {
    return `json_extract(payload_json, '$.turn_id') = ${directParameter}`;
  }
  const repeatedParameter = options.parameterIndex
    ? `?${options.parameterIndex}`
    : "?1";
  return `COALESCE(
    json_extract(payload_json, '$.turn_id'),
    json_extract(payload_json, '$.turn.id'),
    json_extract(payload_json, '$.message.turn_id')
  ) = ${repeatedParameter}`;
}
