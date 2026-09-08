import { appCopy } from "@/app/copy.ts";
import type { McpSecretRowState } from "./mcpSettingsUtils";

export function mcpSecretValuePlaceholder(row: McpSecretRowState): string {
  if (row.redacted) return appCopy.interfaceDetails.secretPlaceholder;
  if (row.source === "env") return "ENV_VAR";
  if (row.source === "file") return "/path/to/secret";
  return "VALUE";
}
