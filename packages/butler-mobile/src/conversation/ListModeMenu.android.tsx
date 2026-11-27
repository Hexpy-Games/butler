import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Box, DropdownMenuGroup, DropdownMenuPopup, Host, IconButton, RNHostView, SelectableDropdownMenuItem, Text } from "@expo/ui/jetpack-compose";
import { semantics } from "@expo/ui/jetpack-compose/modifiers";
import { icons, useTokens } from "@/ds";
import type { ListMode } from "./listMode";
import type { ListModeMenuProps } from "./ListModeMenu";
export type { ListModeMenuProps } from "./ListModeMenu";
const MODES: ListMode[] = ["all", "recent"];
/** Android: an icon button that opens a Material 3 menu with the sorts, current one selected. */
export function ListModeMenu({ value, onChange, labels, label }: ListModeMenuProps) {
  const t = useTokens();
  const [open, setOpen] = useState(false);
  return <Host matchContents colorScheme={t.scheme}>
    <Box>
      <IconButton onClick={() => setOpen(true)} modifiers={[semantics({ contentDescription: `${label}, ${labels[value]}` })]}>
        <RNHostView matchContents><HugeiconsIcon icon={icons.ArrowUpDown} size={t.length("--icon-size-lg")} color={t.color("--text-secondary")} /></RNHostView>
      </IconButton>
      <DropdownMenuPopup expanded={open} onDismissRequest={() => setOpen(false)}>
        <DropdownMenuGroup>
          {MODES.map((mode, index) => <SelectableDropdownMenuItem key={mode} selected={value === mode} shapes={{ index, count: MODES.length }}
            onClick={() => { setOpen(false); onChange(mode); }}>
            <SelectableDropdownMenuItem.Text><Text>{labels[mode]}</Text></SelectableDropdownMenuItem.Text>
          </SelectableDropdownMenuItem>)}
        </DropdownMenuGroup>
      </DropdownMenuPopup>
    </Box>
  </Host>;
}
