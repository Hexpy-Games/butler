import { schemaDigest } from "../progressive-catalog.ts";
import type {
  ToolCapabilityCategory,
  ToolCatalogProvider,
} from "../types.ts";

export function disabledExternalToolDescription(input: {
  id: string;
  name: string;
  namespace: string;
  provider: Exclude<ToolCatalogProvider, "native">;
  category: ToolCapabilityCategory;
  disabledReason: string;
  safetyNotes: string[];
  recoveryHint: string;
}) {
  const schema = {};
  return {
    id: input.id,
    name: input.name,
    namespace: input.namespace,
    provider: input.provider,
    category: input.category,
    enabled: false,
    disabled_reason: input.disabledReason,
    recovery_hint: input.recoveryHint,
    safety_notes: input.safetyNotes,
    schema,
    schema_digest: schemaDigest(schema),
    call_affordance: { type: "disabled", reason: input.disabledReason },
  };
}
