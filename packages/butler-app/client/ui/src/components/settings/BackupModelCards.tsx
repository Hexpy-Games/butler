import { SortableCardList } from "@/butler-ds";
import { modelDisplayName, tokenWindowLabel } from "@/app/utils.ts";
import type { AppModelSummary, SettingsView } from "@/app/types.ts";
import { appCopy } from "@/app/copy.ts";

export function BackupModelCards({
  models,
  fallback,
  saving,
  onUpdate,
}: {
  models: AppModelSummary[];
  fallback: SettingsView["model_fallback"];
  saving: boolean;
  onUpdate: (models: string[]) => void;
}) {
  const cards = fallback.models.flatMap((modelRef) => {
    const model = models.find((candidate) => candidate.model_ref === modelRef);
    return model
      ? [{
          id: model.model_ref,
          label: modelDisplayName(model),
          title: modelDisplayName(model),
          description: `${model.provider_label} · ${model.model_ref}`,
          meta: tokenWindowLabel(model.context_window_tokens),
        }]
      : [];
  });
  return (
    <SortableCardList
      items={cards}
      onReorder={(items) => onUpdate(items.map((item) => item.id))}
      onRemove={(modelRef) =>
        onUpdate(fallback.models.filter((candidate) => candidate !== modelRef))
      }
      disabled={saving}
      emptyMessage={appCopy.settings.backupModels.empty}
      data-test-class="settings-backup-model-list"
    />
  );
}
