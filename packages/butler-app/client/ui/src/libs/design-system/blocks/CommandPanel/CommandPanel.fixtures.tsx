import { ListRow } from "../ListRow";
import { CommandPanel } from "./CommandPanel";

export function CommandPanelFixture() {
  return (
    <CommandPanel query="open" onQueryChange={() => undefined}>
      <ListRow title="Open project dashboard" meta="command" />
    </CommandPanel>
  );
}
