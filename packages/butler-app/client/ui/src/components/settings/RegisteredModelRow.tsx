import {
  Button,
  ButtonContainer,
  Pencil,
  Stack,
  SurfacePanel,
  Trash2,
  Typo,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { modelDisplayName, tokenWindowLabel } from "@/app/utils.ts";
import { ModelAuthTag } from "./ModelAuthTag";
import type { AppModelSummary } from "@/app/types.ts";

interface RegisteredModelRowProps {
  model: AppModelSummary;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

export function RegisteredModelRow({
  model,
  busy,
  onEdit,
  onDelete,
}: RegisteredModelRowProps) {
  const copy = appCopy.settings.modelManagement;
  const name = modelDisplayName(model);

  return (
    <SurfacePanel elevation="none">
      <Stack align="row" justify="between" cross="center" gap="md" wrap>
        <div>
          <Typo.PanelSectionTitle as="h3">
            {model.provider_label} / {name}
          </Typo.PanelSectionTitle>
          <Stack gap="xs">
            <Typo.Caption>
              {tokenWindowLabel(model.context_window_tokens)}
            </Typo.Caption>
            <ModelAuthTag model={model} />
          </Stack>
        </div>
        <ButtonContainer size="sm">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onEdit}
            aria-label={copy.editLabel(name)}
          >
            <Pencil size={14} /> {copy.edit}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onDelete}
            aria-label={copy.deleteLabel(name)}
          >
            <Trash2 size={14} /> {copy.delete}
          </Button>
        </ButtonContainer>
      </Stack>
    </SurfacePanel>
  );
}
