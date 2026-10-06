import type { ReactNode } from "react";
import { Box } from "../../components/Box";
import { dsClass } from "../../lib/internal";
import styles from "./WallpaperStage.module.css";

/** A full viewport backdrop and a centered content layer with two lg insets. */
export function WallpaperStage({ wallpaper, children }: { wallpaper: ReactNode; children: ReactNode }) {
  return <Box surface="base" className={dsClass(styles.stage)}>
    {wallpaper}
    <Box className={dsClass(styles.content)}>{children}</Box>
  </Box>;
}
