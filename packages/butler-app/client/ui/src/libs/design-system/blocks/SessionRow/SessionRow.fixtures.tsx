import { Button } from "../../components/Button";
import { SessionRow } from "./SessionRow";

export function SessionRowFixture() {
  return (
    <SessionRow
      title="Design-system expansion"
      description="Conversation preview text"
      active
      actions={<Button size="xs" variant="borderless">Open</Button>}
    />
  );
}
