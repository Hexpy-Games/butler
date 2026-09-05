import { Plus } from "../Icons";
import { PillButton } from "./PillButton";
import { Stack } from "../Stack";

export function PillButtonFixture() {
  return (
    <Stack gap="sm">
      <PillButton icon={<Plus size={16} />}>Composer pill</PillButton>
      <PillButton surface="glass" icon={<Plus size={16} />}>Task progress · 2/4</PillButton>
    </Stack>
  );
}
