import { ButtonContainer } from "../../components/ButtonContainer";
import { Card } from "../../components/Card";
import { IconButton } from "../../components/IconButton";
import type { MediaFrameAspect } from "../../components/MediaFrame";
import { Skeleton } from "../../components/Skeleton";
import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { cn } from "../../lib/utils";
import styles from "./ItemCard.module.css";

export interface ItemCardSkeletonProps extends DsPrivateStyleProps {
  /** The set's picture aspect (the cards' MediaFrame aspect); `null` for cards without a picture. Default 1:1. */
  media?: MediaFrameAspect | null;
  /** Accessible loading label; without it the skeleton is hidden from assistive technology. */
  label?: string;
}

/** One text line: a box of the role's line height with a bar centred in it, so it is exactly as tall as the text. */
function Line({ role, width }: { role: "subtitle" | "title" | "facts"; width: "3/4" | "2/3" | "2/5" }) {
  return (
    <span className={styles.skeletonLine} data-role={role}>
      <Skeleton className={dsClass(styles.skeletonBar)} width={width} height={role === "title" ? "title" : "line"} />
    </span>
  );
}

/**
 * The loading shape of an `ItemCard`, built on the same card, grid tracks and container query: the picture
 * box at the set's aspect, three text lines (subtitle, title, facts) and the footer line with the actions'
 * height. It reserves exactly the room of a card with those parts, in the vertical and the row orientation,
 * so a skeleton that becomes that card shifts nothing. The footer keeps one invisible IconButton, so its
 * height follows the actions on every pointer and viewport.
 */
export function ItemCardSkeleton({ media = "1:1", label, className }: ItemCardSkeletonProps) {
  return (
    <div className={cn(styles.root, className)} data-slot="item-card-skeleton" role={label ? "status" : undefined}
      aria-hidden={label ? undefined : true}>
      {label ? <span className="sr-only">{label}</span> : null}
      <Card className={dsClass(styles.card)} padding="sm" data-media={media ? "true" : undefined}>
        {media ? (
          <span className={styles.media}>
            <Skeleton className={dsClass(styles.skeletonMedia)} data-aspect={media} />
          </span>
        ) : null}
        <span className={styles.body}>
          <Line role="subtitle" width="2/5" />
          <Line role="title" width="3/4" />
          <Line role="facts" width="2/3" />
        </span>
        <span className={styles.footer}>
          <span className={styles.source}><Skeleton width="1/2" height="line" /></span>
          <ButtonContainer className={dsClass(styles.actions)} size="icon-sm">
            <IconButton className={dsClass(styles.skeletonAction)} label="" tabIndex={-1} aria-hidden="true" />
          </ButtonContainer>
        </span>
      </Card>
    </div>
  );
}
