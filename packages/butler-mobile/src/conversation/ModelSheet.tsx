import { View } from "react-native";
import { reasoningEffortLabel } from "../../../butler-i18n/src/reasoning-effort.ts";
import { ListRow, Sheet, Text, useTokens } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import type { useControls } from "./useControls";

export function ModelSheet({ open, onClose, controls, models, current, apply }: ReturnType<typeof useControls> & {
  open: boolean; onClose(): void;
}) {
  const copy = useMobileCopy();
  const locale = useAppLocale();
  const t = useTokens();
  return <Sheet open={open} onClose={onClose} title={copy.chat.model} cancelLabel={copy.chat.close}>
    <View style={{ gap: t.length("--space-4") }}>
      {current?.reasoning_efforts.length ? <View style={{ gap: t.length("--space-4") }}>
        <Text variant="sectionTitle" tone="secondary">{copy.chat.reasoning}</Text>
        {current.reasoning_efforts.map(effort => <ListRow key={effort} title={reasoningEffortLabel(effort, locale)}
          selected={controls?.reasoning_effort === effort} onPress={() => { void apply({ reasoning_effort: effort }); onClose(); }} />)}
      </View> : null}
      <Text variant="sectionTitle" tone="secondary">{copy.chat.model}</Text>
      {models.map(model => {
        const disabled = !!model.availability && model.availability !== "ready";
        return <ListRow key={model.model_ref} title={model.display_name} description={model.provider_label}
          selected={model.model_ref === controls?.model} disabled={disabled} meta={disabled ? copy.chat.modelUnavailable : undefined}
          onPress={() => { void apply({ model: model.model_ref }); onClose(); }} />;
      })}
    </View>
  </Sheet>;
}
