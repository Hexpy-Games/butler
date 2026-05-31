import type { McpSecretRowState } from "./mcpSettingsUtils";

export function mcpSecretValuePlaceholder(row: McpSecretRowState): string {
  if (row.redacted) return "저장된 값 유지 또는 새 값";
  if (row.source === "env") return "ENV_VAR";
  if (row.source === "file") return "/path/to/secret";
  return "VALUE";
}
