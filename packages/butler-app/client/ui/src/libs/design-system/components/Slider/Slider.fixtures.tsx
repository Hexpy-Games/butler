import { Stack } from "../Stack";
import { Slider } from "./Slider";

export function SliderFixture() {
  return (
    <Stack gap="2">
      <Slider
        aria-label="Context limit"
        min={1000}
        max={1000000}
        step={1000}
        value={285000}
      />
      <Slider
        aria-label="Disabled slider"
        disabled
        min={0}
        max={100}
        value={40}
      />
    </Stack>
  );
}
