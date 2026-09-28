import type { NavRowItem } from "../../../site/nav";
import { Card } from "../../components/Card";
import { ArrowLeft, ArrowRight } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import styles from "./PrevNext.module.css";

export interface PrevNextLinksProps {
  prev?: NavRowItem;
  next?: NavRowItem;
  labels: { prev: string; next: string; nav: string };
}

/** Previous / next published pages as link cards. */
export function PrevNextLinks({ prev, next, labels }: PrevNextLinksProps) {
  if (!prev && !next) return null;
  return (
    <nav aria-label={labels.nav} className={styles.grid}>
      {prev?.href ? (
        <Card href={prev.href} padding="lg">
          <span className={styles.item}>
            <Typo.Caption tone="tertiary"><span className={styles.meta}><ArrowLeft size="sm" />{labels.prev}</span></Typo.Caption>
            <Typo.Label>{prev.label}</Typo.Label>
          </span>
        </Card>
      ) : <span />}
      {next?.href ? (
        <Card href={next.href} padding="lg">
          <span className={styles.item} data-align="end">
            <Typo.Caption tone="tertiary"><span className={styles.meta}>{labels.next}<ArrowRight size="sm" /></span></Typo.Caption>
            <Typo.Label>{next.label}</Typo.Label>
          </span>
        </Card>
      ) : null}
    </nav>
  );
}
