import { Search, SlidersHorizontal } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { ComposerControl } from "./ComposerControl";

export function ComposerControlFixture() {
  return (
    <Stack align="row" gap="sm" wrap>
      <ComposerControl icon={<Search size={15} />} label="Ask" detail="workspace" active />
      <ComposerControl icon={<SlidersHorizontal size={15} />} label="Reasoning" detail="medium" />
    </Stack>
  );
}
