import { HIDDEN_LEGACY_ASSISTANT_SAFE_ERROR_CODES } from "../../infrastructure/transport/btcc-public-projection.ts";

export function visibleMessageSqlPredicate(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  const codes = HIDDEN_LEGACY_ASSISTANT_SAFE_ERROR_CODES.map(
    (code) => `'${code}'`,
  ).join(", ");
  return `NOT (${prefix}role = 'assistant' AND ${prefix}safe_error_code IS NOT NULL AND ${prefix}safe_error_code IN (${codes}))`;
}
