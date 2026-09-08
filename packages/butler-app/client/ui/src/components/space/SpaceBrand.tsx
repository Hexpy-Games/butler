import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { Stack, Typo } from "@/butler-ds";
import styles from "./SpaceSidebar.module.css";

export function SpaceBrand() {
  useAppLocale();
  return (
    <Stack align="row" cross="center" className={styles.brand}>
      <Typo.AppTitle>{appCopy.firstRun.product}</Typo.AppTitle>
    </Stack>
  );
}
