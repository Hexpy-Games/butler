import { Host, Picker, Text } from "@expo/ui/swift-ui";
import { accessibilityLabel, environment, frame, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { useTokens } from "@/ds";
import type { ListMode } from "./listMode";
export interface ListModePickerProps { value: ListMode; onChange(mode: ListMode): void; labels: Record<ListMode, string>; label: string }
/** iOS: SwiftUI segmented Picker; Android uses ListModePicker.android.tsx (Material 3 segmented buttons). */
export function ListModePicker({ value, onChange, labels, label }: ListModePickerProps) {
  const t = useTokens();
  return <Host matchContents={{ vertical: true }}>
    <Picker selection={value} onSelectionChange={(mode: ListMode) => onChange(mode === "recent" ? "recent" : "all")}
      modifiers={[pickerStyle("segmented"), accessibilityLabel(label), environment("colorScheme", t.scheme), frame({ maxWidth: Infinity })]}>
      <Text modifiers={[tag("all")]}>{labels.all}</Text>
      <Text modifiers={[tag("recent")]}>{labels.recent}</Text>
    </Picker>
  </Host>;
}
