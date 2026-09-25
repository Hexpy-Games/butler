import { OverflowActionMenu } from "./OverflowActionMenu";
import { Pencil, Archive, Trash2 } from "../../components/Icons";

export function OverflowActionMenuFixture() {
  return (
    <OverflowActionMenu
      items={[
        { icon: <Pencil size="sm" />, label: "Rename", onSelect: () => {} },
        { icon: <Archive size="sm" />, label: "Archive", onSelect: () => {} },
        { icon: <Trash2 size="sm" />, label: "Delete", onSelect: () => {}, variant: "destructive" },
      ]}
    />
  );
}
