import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Box, DropdownMenuGroup, DropdownMenuPopup, Host, SelectableDropdownMenuItem, Text as ComposeText } from "@expo/ui/jetpack-compose";
import { fillMaxSize } from "@expo/ui/jetpack-compose/modifiers";
import { icons, Text, useTokens } from "@/ds";
import type { ListMode } from "./listMode";
import type { ListModeMenuProps } from "./ListModeMenu";
export type { ListModeMenuProps } from "./ListModeMenu";
const MODES: ListMode[] = ["all", "recent"];
/** UnfoldMore's ink ends at x 18.75 of 24 (path x 18 + half the 1.5 stroke). */
const UNFOLD_INK_INSET = 5.25 / 24;
/** Android: the current sort plus an unfold glyph in the header caption style; opens a Material 3 menu anchored to it, current one selected. */
export function ListModeMenu({ value, onChange, labels, label, endInset }: ListModeMenuProps) {
  const t = useTokens();
  const [open, setOpen] = useState(false);
  const glyph = t.length("--icon-size-md");
  return <View>
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}, ${labels[value]}`} onPress={() => setOpen(true)}
      android_ripple={{ color: t.color("--selection-strong"), borderless: true }}
      style={{ flexDirection: "row", alignItems: "center", gap: t.length("--space-1"), minHeight: t.length("--control-hit-target"),
        paddingLeft: t.length("--space-sm"), paddingRight: endInset - glyph * UNFOLD_INK_INSET }}>
      <Text variant="caption" tone="secondary" weight="medium" lines={1}>{labels[value]}</Text>
      <HugeiconsIcon icon={icons.UnfoldMore} size={glyph} color={t.color("--text-secondary")} />
    </Pressable>
    <Host style={StyleSheet.absoluteFill} pointerEvents="none" colorScheme={t.scheme}>
      <Box modifiers={[fillMaxSize()]}>
        <DropdownMenuPopup expanded={open} onDismissRequest={() => setOpen(false)}>
          <DropdownMenuGroup>
            {MODES.map((mode, index) => <SelectableDropdownMenuItem key={mode} selected={value === mode} shapes={{ index, count: MODES.length }}
              onClick={() => { setOpen(false); onChange(mode); }}>
              <SelectableDropdownMenuItem.Text><ComposeText>{labels[mode]}</ComposeText></SelectableDropdownMenuItem.Text>
            </SelectableDropdownMenuItem>)}
          </DropdownMenuGroup>
        </DropdownMenuPopup>
      </Box>
    </Host>
  </View>;
}
