import { Plus } from "../Icons";
import { PillButton } from "./PillButton";
import { Stack } from "../Stack";

export function PillButtonFixture() {
  return (
    <Stack gap="sm">
      <PillButton icon={<Plus size="md" />}>Composer pill</PillButton>
      <PillButton surface="glass" icon={<Plus size="md" />}>Task progress · 2/4</PillButton>
    </Stack>
  );
}
