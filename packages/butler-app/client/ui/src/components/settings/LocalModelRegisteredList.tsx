import { Stack, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { LocalModelRow } from "./LocalModelRow";
import type { AppModelSummary } from "@/app/types.ts";

interface LocalModelRegisteredListProps {
  models: AppModelSummary[];
  busy: boolean;
  editingModelRef: string;
  onEdit: (model: AppModelSummary) => void;
  onDelete: (model: AppModelSummary) => void;
}

export function LocalModelRegisteredList({
  models,
  busy,
  editingModelRef,
  onEdit,
  onDelete,
}: LocalModelRegisteredListProps) {
  const copy = appCopy.settings.localModels;
  if (models.length === 0) return null;

  return (
    <Stack gap="sm" aria-label={copy.registeredLocalModels}>
      <Typo.PanelSectionTitle as="h4">
        {copy.registeredLocalModels}
      </Typo.PanelSectionTitle>
      {models.map((model) => (
        <LocalModelRow
          key={model.model_ref}
          model={model}
          busy={busy}
          editing={editingModelRef === model.model_ref}
          onEdit={() => onEdit(model)}
          onDelete={() => onDelete(model)}
        />
      ))}
    </Stack>
  );
}
