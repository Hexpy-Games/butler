import { Host, Image, Menu, Picker, Text } from "@expo/ui/swift-ui";
import { accessibilityLabel, accessibilityValue, buttonStyle, contentShape, frame, menuIndicator, menuStyle, pickerStyle, shapes, tag } from "@expo/ui/swift-ui/modifiers";
import { useTokens } from "@/ds";
import type { ListMode } from "./listMode";
export interface ListModeMenuProps { value: ListMode; onChange(mode: ListMode): void; labels: Record<ListMode, string>; label: string }
/** iOS: an icon that opens a SwiftUI pull-down menu with the sorts, current one checked; Android uses ListModeMenu.android.tsx. */
export function ListModeMenu({ value, onChange, labels, label }: ListModeMenuProps) {
  const t = useTokens();
  const hit = t.length("--control-hit-target");
  return <Host matchContents colorScheme={t.scheme}>
    <Menu label={<Image systemName="arrow.up.arrow.down" size={t.length("--icon-size-lg")} color={t.color("--text-secondary")} />}
      modifiers={[menuStyle("button"), buttonStyle("plain"), menuIndicator("hidden"), frame({ width: hit, height: hit }),
        contentShape(shapes.rectangle()), accessibilityLabel(label), accessibilityValue(labels[value])]}>
      <Picker selection={value} onSelectionChange={(mode: ListMode) => onChange(mode === "recent" ? "recent" : "all")} modifiers={[pickerStyle("inline")]}>
        <Text modifiers={[tag("all")]}>{labels.all}</Text>
        <Text modifiers={[tag("recent")]}>{labels.recent}</Text>
      </Picker>
    </Menu>
  </Host>;
}
