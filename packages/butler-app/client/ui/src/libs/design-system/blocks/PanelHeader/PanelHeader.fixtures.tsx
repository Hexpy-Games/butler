import { PanelHeader } from "./PanelHeader";
import { Button } from "../../components/Button";
import { Plus } from "../../components/Icons";

export function PanelHeaderFixture() {
  return (
    <PanelHeader
      title="Context Usage"
      description="View and manage context consumption"
      actions={<Button iconStart={<Plus size={16} />} text="Add" variant="outline" />}
    />
  );
}
