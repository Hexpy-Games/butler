import { useWindowDimensions } from "react-native";
import { Host, HStack, Image, Menu, Picker, Text } from "@expo/ui/swift-ui";
import {
  accessibilityLabel, accessibilityValue, buttonStyle, contentShape, dynamicTypeSize, font, foregroundStyle, frame, imageScale, lineLimit, menuIndicator,
  menuStyle, padding, pickerStyle, shapes, tag,
} from "@expo/ui/swift-ui/modifiers";
import { useTokens } from "@/ds";
import { textStyle, variantMaxScale } from "@/ds/internal/typography";
import type { ListMode } from "./listMode";
/** chevron.up.chevron.down at small scale: its layout box extends 0.097 em past the ink on each side (measured at 56 and 84 pt). */
const GLYPH_SIDE_BEARING = 0.097;
/** `endInset`: distance from the trigger's right edge to where the glyph's ink must end (the row chevron column). */
export interface ListModeMenuProps { value: ListMode; onChange(mode: ListMode): void; labels: Record<ListMode, string>; label: string; endInset: number }
/** iOS: the current sort plus an up/down chevron, drawn natively in the header caption style; opens a SwiftUI pull-down with the sorts, current one checked. */
export function ListModeMenu({ value, onChange, labels, label, endInset }: ListModeMenuProps) {
  const t = useTokens();
  const { fontScale } = useWindowDimensions();
  // The size the header's RN caption Text draws at; SwiftUI's own Dynamic Type scaling is pinned off below so the two never differ.
  const size = t.length("--typo-caption-size") * Math.min(fontScale, variantMaxScale("caption"));
  // An Image takes its size from its own font modifier only (it defaults to 24 pt), so the caption font goes on both children.
  const caption = font({ family: textStyle(t, "caption", "medium").fontFamily, size, weight: "medium" });
  const trigger = <HStack spacing={t.length("--space-1")} alignment="firstTextBaseline"
    modifiers={[dynamicTypeSize("large"), foregroundStyle(t.color("--text-secondary")),
      padding({ leading: t.length("--space-sm"), trailing: endInset - size * GLYPH_SIDE_BEARING }),
      frame({ minHeight: t.length("--control-hit-target") }), contentShape(shapes.rectangle())]}>
    <Text modifiers={[caption, lineLimit(1)]}>{labels[value]}</Text>
    <Image systemName="chevron.up.chevron.down" modifiers={[caption, imageScale("small")]} />
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
