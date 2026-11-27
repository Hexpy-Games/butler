import { Host, SegmentedButton, SingleChoiceSegmentedButtonRow, Text } from "@expo/ui/jetpack-compose";
import { fillMaxWidth, semantics } from "@expo/ui/jetpack-compose/modifiers";
import type { ListMode } from "./listMode";
import type { ListModePickerProps } from "./ListModePicker";
export type { ListModePickerProps } from "./ListModePicker";
const MODES: ListMode[] = ["all", "recent"];
export function ListModePicker({ value, onChange, labels, label }: ListModePickerProps) {
  return <Host matchContents={{ vertical: true }}>
    <SingleChoiceSegmentedButtonRow modifiers={[fillMaxWidth(), semantics({ contentDescription: label })]}>
      {MODES.map(mode => <SegmentedButton key={mode} selected={value === mode} onClick={() => onChange(mode)}>
        <SegmentedButton.Label><Text>{labels[mode]}</Text></SegmentedButton.Label>
      </SegmentedButton>)}
    </SingleChoiceSegmentedButtonRow>
  </Host>;
}
