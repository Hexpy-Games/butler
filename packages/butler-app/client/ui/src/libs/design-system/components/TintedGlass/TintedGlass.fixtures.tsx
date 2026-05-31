import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { TintedGlass } from "./TintedGlass";
import styles from "./TintedGlass.fixtures.module.css";

export function TintedGlassFixture() {
  return (
    <div className={styles.stage}>
      <div className={styles.backgroundText} aria-hidden="true">
        <span>Context behind glass</span>
        <span>Readable blur sample</span>
        <span>20px fixed edge fade</span>
      </div>
      <div className={styles.pictureMarks} aria-hidden="true">
        <span className={`${styles.mark} ${styles.markOne}`} />
        <span className={`${styles.mark} ${styles.markTwo}`} />
        <span className={`${styles.mark} ${styles.markThree}`} />
      </div>
      <Stack className={styles.stack} gap="2">
        <TintedGlass className={styles.demo} padding="lg" radius="composer">
          <Typo.PanelSectionTitle>Composer surface</Typo.PanelSectionTitle>
          <Typo.Body>
            Edge fades reveal the 4px blur while the center stays opaque like
            the composer surface.
          </Typo.Body>
        </TintedGlass>
        <TintedGlass className={styles.compact} padding="sm" radius="popover">
          <Typo.Caption>Popover sized surface</Typo.Caption>
        </TintedGlass>
      </Stack>
    </div>
  );
}
