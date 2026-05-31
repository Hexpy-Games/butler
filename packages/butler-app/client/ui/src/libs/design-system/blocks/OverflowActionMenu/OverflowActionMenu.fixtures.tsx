import { OverflowActionMenu } from "./OverflowActionMenu";
import { Pencil, Archive, Trash2 } from "../../components/Icons";

export function OverflowActionMenuFixture() {
  return (
    <OverflowActionMenu
      items={[
        { icon: <Pencil size={14} />, label: "Rename", onSelect: () => {} },
        { icon: <Archive size={14} />, label: "Archive", onSelect: () => {} },
        { icon: <Trash2 size={14} />, label: "Delete", onSelect: () => {}, variant: "destructive" },
      ]}
    />
  );
}
