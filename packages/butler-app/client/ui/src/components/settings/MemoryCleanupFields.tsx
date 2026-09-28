import { useAppLocale } from "@/app/copy.ts";
import { ButlerConsolidationSettings } from "./ButlerConsolidationSettings";
import { useButlerModels } from "./hooks/useButlerModels";

/** Memory cleanup section: the model (and its reasoning) that consolidates memory. */
export function MemoryCleanupFields() {
  useAppLocale();
  const { draft, models, activeModel, updateSettings } = useButlerModels();
  if (!draft) return null;
  return (
    <ButlerConsolidationSettings models={models} activeModel={activeModel} draft={draft} onUpdate={updateSettings} />
  );
}
