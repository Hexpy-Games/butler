import { Tag } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { AppModelSummary } from "@/app/types.ts";

interface ModelAuthTagProps {
  model: AppModelSummary;
}

export function ModelAuthTag({ model }: ModelAuthTagProps) {
  if (!model.auth_type) return null;
  const copy = appCopy.settings.modelManagement;
  const authLabel =
    model.auth_type === "codex_oauth" ? copy.codexOauth : copy.apiKeyAuth;
  const label = model.credential_masked_value
    ? copy.authTag(authLabel, model.credential_masked_value)
    : authLabel;

  return <Tag ariaLabel={label}>{label}</Tag>;
}
