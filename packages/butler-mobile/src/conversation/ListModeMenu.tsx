import { Host, HStack, Image, Menu, Picker, Text } from "@expo/ui/swift-ui";
import {
  accessibilityLabel, accessibilityValue, buttonStyle, contentShape, font, foregroundStyle, frame, lineLimit, menuIndicator, menuStyle, padding,
  pickerStyle, shapes, tag,
} from "@expo/ui/swift-ui/modifiers";
import { useTokens } from "@/ds";
import { textStyle } from "@/ds/internal/typography";
import type { ListMode } from "./listMode";
/** `endInset`: distance from the trigger's right edge to where the glyph's ink must end (the row chevron column). */
export interface ListModeMenuProps { value: ListMode; onChange(mode: ListMode): void; labels: Record<ListMode, string>; label: string; endInset: number }
/** iOS: the current sort plus an up/down chevron, drawn natively in the header caption style; opens a SwiftUI pull-down with the sorts, current one checked. */
export function ListModeMenu({ value, onChange, labels, label, endInset }: ListModeMenuProps) {
  const t = useTokens();
  const type = textStyle(t, "caption", "medium");
  const trigger = <HStack spacing={t.length("--space-1")} alignment="firstTextBaseline"
    modifiers={[font({ family: type.fontFamily, size: type.fontSize, weight: "medium" }), foregroundStyle(t.color("--text-secondary")),
      padding({ leading: t.length("--space-sm"), trailing: endInset }), frame({ minHeight: t.length("--control-hit-target") }), contentShape(shapes.rectangle())]}>
    <Text modifiers={[lineLimit(1)]}>{labels[value]}</Text>
    <Image systemName="chevron.up.chevron.down" />
  </HStack>;
  return <Host matchContents alignment="trailing" colorScheme={t.scheme}>
    <Menu label={trigger} modifiers={[menuStyle("button"), buttonStyle("plain"), menuIndicator("hidden"), accessibilityLabel(label), accessibilityValue(labels[value])]}>
      <Picker selection={value} onSelectionChange={(mode: ListMode) => onChange(mode === "recent" ? "recent" : "all")} modifiers={[pickerStyle("inline")]}>
        <Text modifiers={[tag("all")]}>{labels.all}</Text>
        <Text modifiers={[tag("recent")]}>{labels.recent}</Text>
      </Picker>
    </Menu>
  </Host>;
}
