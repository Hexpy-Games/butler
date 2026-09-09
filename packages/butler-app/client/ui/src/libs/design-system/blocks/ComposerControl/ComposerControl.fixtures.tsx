import { Search, ShieldCheck, SlidersHorizontal } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { ComposerControl } from "./ComposerControl";
import styles from "./ComposerControl.module.css";

export function ComposerControlFixture() {
  return (
    <div className={styles.fixture}>
      <Stack align="row" gap="sm" wrap>
        <ComposerControl icon={<Search size={15} />} label="Ask" detail="workspace" active />
        <ComposerControl icon={<SlidersHorizontal size={15} />} label="Reasoning" detail="medium" />
        <ComposerControl icon={<ShieldCheck size={16} />} label="Full access" compact="icon" />
      </Stack>
    </div>
  );
}
