import { useId, type MouseEvent, type ReactNode } from "react";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Card } from "../../components/Card";
import { Clickable } from "../../components/Clickable";
import { Tag } from "../../components/Tag";
import { Typo } from "../../components/Typo";
import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { SiteIcon } from "../../lib/SiteIcon";
import { cn } from "../../lib/utils";
import { ItemCardText } from "./ItemCardText";
import styles from "./ItemCard.module.css";

/** A labelled value, already formatted by the container ("76,390원", "4.6 km", "25 min", "38.2k stars"). */
export interface ItemCardValue {
  amount: string;
  /** An earlier or reference amount, struck through. */
  was?: string;
  /** Screen-reader prefix for `was` ("Before" / "이전"); the strike-through alone is not announced. */
  wasLabel?: string;
  /** One condition line under the amount. */
  note?: string;
}

/** Where the card's values were read: the footer's provenance line, a button that opens the page. */
export interface ItemCardSource {
  /** Domain or site name ("arxiv.org"). */
  site: string;
  /** Formatted read time ("Checked 5:41 PM" / "오후 5:41 확인"). A row card shows "site · checked". */
  checked?: string;
  /** Favicon URL; a globe without it. */
  icon?: string;
  /** Accessible name of the button ("Open arxiv.org, checked at 5:41 PM"). */
  label: string;
  onOpen: () => void;
}

export interface ItemCardProps extends DsPrivateStyleProps {
  title: string;
  /** A short Tag above the title: a rank or a reason. */
  eyebrow?: string;
  /** Author, venue, area or maker, one line above the title. */
  subtitle?: string;
  /** A MediaFrame; the container picks one aspect for the whole set. */
  media?: ReactNode;
  value?: ItemCardValue;
  /** Short facts, one dot-separated line that wraps. */
  facts?: readonly string[];
  /** Plain text. A vertical card clamps it to four lines; with both labels a button reveals the rest. */
  text?: string;
  showMoreLabel?: string;
  showLessLabel?: string;
  source?: ItemCardSource;
  /** Footer IconButtons and CopyButtons (icon-sm), set in a ButtonContainer by the card. */
  actions?: ReactNode;
  /** Opens the item; the media and the title are the target. */
  onOpen?: (event: MouseEvent) => void;
}

function Value({ value }: { value: ItemCardValue }) {
  return (
    <span className={styles.value}>
      <span className={styles.amounts}>
        <Typo.MetricValue numeric="tabular">{value.amount}</Typo.MetricValue>
        {value.was ? (
          <Typo.Caption tone="tertiary" numeric="tabular">
            {value.wasLabel ? <span className="sr-only">{`${value.wasLabel} `}</span> : null}
            <s className={styles.was}>{value.was}</s>
          </Typo.Caption>
        ) : null}
      </span>
      {value.note ? <Typo.Caption tone="secondary">{value.note}</Typo.Caption> : null}
    </span>
  );
}

function Footer({ source, actions }: Pick<ItemCardProps, "source" | "actions">) {
  return (
    <span className={styles.footer} data-slot="item-card-footer">
      {source ? (
        <Clickable className={dsClass(styles.source)} variant="text" aria-label={source.label} title={source.label} onClick={source.onOpen}>
          <SiteIcon src={source.icon} />
          <Typo.Caption tone="tertiary" truncate>
            {source.checked ? <><span className={styles.site}>{`${source.site} · `}</span>{source.checked}</> : source.site}
          </Typo.Caption>
        </Clickable>
      ) : <span className={styles.source} />}
      {actions ? <ButtonContainer size="icon-sm">{actions}</ButtonContainer> : null}
    </span>
  );
}

/**
 * One found item (a paper, a place, a recipe, a product, a library) on a Card: picture, eyebrow, subtitle,
 * title, a value, facts, text and a footer with its source and actions. Below 340px of its own width it
 * stacks; at 340px and up it is a row with a 112px picture on the start side.
 */
export function ItemCard({
  title, eyebrow, subtitle, media, value, facts = [], text, showMoreLabel, showLessLabel, source, actions, onOpen, className,
}: ItemCardProps) {
  const titleId = useId();
  const heading = <Typo.Text id={titleId} className={dsClass(styles.title)} weight="semibold" lineClamp={2}>{title}</Typo.Text>;
  return (
    <article className={cn(styles.root, className)} aria-labelledby={titleId} data-slot="item-card">
      <Card className={dsClass(styles.card)} padding="sm" interactive={Boolean(onOpen)} data-media={media ? "true" : undefined}>
        {media ? (
          onOpen ? (
            <Clickable className={dsClass(styles.media)} variant="text" tabIndex={-1} aria-hidden="true" onClick={onOpen}>{media}</Clickable>
          ) : <span className={styles.media}>{media}</span>
        ) : null}
        <span className={styles.body}>
          {eyebrow ? <span className={styles.eyebrow}><Tag tone="accent" size="sm">{eyebrow}</Tag></span> : null}
          {subtitle ? <Typo.Caption tone="tertiary" truncate>{subtitle}</Typo.Caption> : null}
          {onOpen ? <Clickable className={dsClass(styles.open)} variant="text" onClick={onOpen}>{heading}</Clickable> : heading}
          {value ? <Value value={value} /> : null}
          {facts.length ? (
            <ul className={styles.facts}>
              {facts.map((fact, index) => <li key={`${index}:${fact}`} className={styles.fact}>{fact}</li>)}
            </ul>
          ) : null}
          {text ? <ItemCardText text={text} showMoreLabel={showMoreLabel} showLessLabel={showLessLabel} /> : null}
        </span>
        {source || actions ? <Footer source={source} actions={actions} /> : null}
      </Card>
    </article>
  );
}
