import { Stack, Typo } from "@/butler-ds";
import styles from "./SpaceSidebar.module.css";

export function SpaceBrand() {
  return (
    <Stack align="row" cross="center" className={styles.brand}>
      <Typo.AppTitle>Butler</Typo.AppTitle>
    </Stack>
  );
}
