import { Stack } from "../../components/Stack";
import { ProgressMeter } from "./ProgressMeter";

export function ProgressMeterFixture() {
  return (
    <Stack gap="sm">
      <ProgressMeter label="Context window" value={64} />
      <ProgressMeter label="Retry budget" value={24} tone="warning" />
    </Stack>
  );
}
