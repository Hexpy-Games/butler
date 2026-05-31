import { Pencil, Trash2 } from "@/butler-ds";
import {
  Button,
  ButtonContainer,
  ListRow,
  Stack,
  SurfacePanel,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { modelDisplayName, tokenWindowLabel } from "@/app/utils.ts";
import { ratioToPercent } from "./settingsUtils";
import type { AppModelSummary } from "@/app/types.ts";

interface LocalModelRowProps {
  model: AppModelSummary;
  busy: boolean;
  editing: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

export function LocalModelRow({
  model,
  busy,
  editing,
  onEdit,
  onDelete,
}: LocalModelRowProps) {
  const copy = appCopy.settings.localModels;

  return (
    <SurfacePanel
      data-editing={editing ? "true" : "false"}
      data-test-class="registered-local-model-row"
      elevation="none"
    >
      <Stack align="row" justify="between" cross="center" gap="md">
        <ListRow
          title={modelDisplayName(model)}
          description={model.model_ref}
          meta={`${tokenWindowLabel(model.context_window_tokens)} · ${reasoningBudgetLabel(model.local_reasoning_budget_ratio)}`}
        />
        <ButtonContainer size="icon-sm">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            onClick={onEdit}
            aria-label={copy.editLabel(modelDisplayName(model))}
          >
            <Pencil size={14} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            onClick={onDelete}
            aria-label={copy.deleteLabel(modelDisplayName(model))}
          >
            <Trash2 size={14} />
          </Button>
        </ButtonContainer>
      </Stack>
    </SurfacePanel>
  );
}

function reasoningBudgetLabel(value: number | undefined): string {
  return appCopy.settings.localModels.reasoningBudgetLabel(
    ratioToPercent(value),
  );
}
