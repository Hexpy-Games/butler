import { View } from "react-native";
import { reasoningEffortLabel } from "../../../butler-i18n/src/reasoning-effort.ts";
import type { ModelSummary } from "../../../butler-protocol/src/index.ts";
import { ListGroup, ListRow, Sheet, useTokens } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { usePicked } from "@/settings/rows";
import { ModelMark } from "./ModelMark";
import type { useControls } from "./useControls";

export function ModelSheet({ open, onClose, controls, models, current, apply }: ReturnType<typeof useControls> & {
  open: boolean; onClose(): void;
}) {
  const copy = useMobileCopy();
  const locale = useAppLocale();
  const t = useTokens();
  const picked = usePicked();
  const providers = new Map<string, ModelSummary[]>();
  for (const model of models) providers.set(model.provider_label, [...(providers.get(model.provider_label) ?? []), model]);
  return <Sheet open={open} onClose={onClose} title={copy.chat.model} cancelLabel={copy.chat.close}>
    <View style={{ gap: t.length("--space-4") }}>
      {current?.reasoning_efforts.length ? <ListGroup label={copy.chat.reasoning}>
        {current.reasoning_efforts.map(effort => {
          const on = controls?.reasoning_effort === effort, title = reasoningEffortLabel(effort, locale);
          return <ListRow key={effort} title={title} {...picked(on, [title])}
            onPress={() => { void apply({ reasoning_effort: effort }); onClose(); }} />;
        })}
      </ListGroup> : null}
      {[...providers].map(([provider, list]) => <ListGroup key={provider} label={provider}>
        {list.map(model => {
          const disabled = !!model.availability && model.availability !== "ready";
          const on = model.model_ref === controls?.model;
          return <ListRow key={model.model_ref} icon={<ModelMark model={model} />} title={model.display_name}
            meta={disabled ? copy.chat.modelUnavailable : undefined} disabled={disabled}
            {...picked(on, [model.display_name, disabled ? copy.chat.modelUnavailable : undefined])}
            onPress={() => { void apply({ model: model.model_ref }); onClose(); }} />;
        })}
      </ListGroup>)}
    </View>
  </Sheet>;
}
