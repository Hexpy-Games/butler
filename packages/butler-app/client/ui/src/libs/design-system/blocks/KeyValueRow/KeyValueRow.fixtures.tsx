import { Stack } from "../../components/Stack";
import { KeyValueRow } from "./KeyValueRow";
import styles from "./KeyValueRow.module.css";

export function KeyValueRowFixture() {
  return (
    <Stack gap="xs">
      <KeyValueRow label="Context" value="64%" meta="healthy" />
      <KeyValueRow label="Files" value="12" description="Pinned sources" swatch={<span className={styles["sample-swatch"]} />} />
    </Stack>
  );
}
