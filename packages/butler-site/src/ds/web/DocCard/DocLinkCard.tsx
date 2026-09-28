import { Card } from "../../components/Card";
import { ArrowRight, ArrowUpRight } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import styles from "./DocCard.module.css";

export interface DocLinkCardProps {
  title: string;
  description: string;
  /** Omitted for a planned page: the card renders disabled. */
  href?: string;
  external?: boolean;
  plannedLabel: string;
}

export function DocLinkCard({ title, description, href, external = false, plannedLabel }: DocLinkCardProps) {
  return (
    <Card disabled={!href} external={external} href={href} padding="lg">
      <span className={styles.body}>
        <span className={styles.head}>
          <Typo.Label tone={href ? "primary" : "inherit"}>{title}</Typo.Label>
          <span className={styles.trail}>
            {!href ? <Typo.Caption>{plannedLabel}</Typo.Caption> : external ? <ArrowUpRight size="sm" /> : <ArrowRight size="sm" />}
          </span>
        </span>
        <Typo.Caption tone={href ? "secondary" : "inherit"}>{description}</Typo.Caption>
      </span>
    </Card>
  );
}
