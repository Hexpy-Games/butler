import { Button } from "../../components/Button";
import { ButlerThinkingMark } from "../../components/ButlerThinkingMark";
import { Clickable } from "../../components/Clickable";
import { IconButton } from "../../components/IconButton";
import { X } from "../../components/Icons";
import { Tag, type TagTone } from "../../components/Tag";
import { Typo } from "../../components/Typo";
import { dsClass } from "../../lib/internal";
import { SiteIcon } from "../../lib/SiteIcon";
import { LiveTabChip, LiveTabCompact } from "./LiveTabCardCompact";
import { LiveTabFrame, type LiveTabFrameSource } from "./LiveTabFrame";
import styles from "./LiveTabCard.module.css";

/**
 * `busy` Butler is acting (thinking mark, faint ink ring); `held` the user holds the tab;
 * `attention` waiting for the user (amber ring; approval, sign-in, payment, a dialog); `error` crashed or failed.
 */
export type LiveTabState = "idle" | "busy" | "held" | "attention" | "error";
/** `full` rail card with a title row; `compact` a bare thumbnail; `chip` a shelf chip. */
export type LiveTabCardVariant = "full" | "compact" | "chip";

export interface LiveTabCardAction {
  label: string;
  onAction: () => void;
}

export interface LiveTabCardProps {
  title: string;
  /** The shelf chip's label (the site name). Default: `title`. */
  shortTitle?: string;
  favicon?: string;
  frame?: LiveTabFrameSource | null;
  state?: LiveTabState;
  /** The state's word: the Tag of held, attention and error; the busy mark's name in the card's label. */
  stateLabel?: string;
  /** Attention only: the needs-you band, what is needed and its action (열어서 확인 / Open to check). */
  needsYou?: { detail?: string; action: LiveTabCardAction };
  /** Error only: the overlay over the greyed frame and its recovery action (새로고침 / Reload). */
  failure?: { label: string; action?: LiveTabCardAction };
  variant?: LiveTabCardVariant;
  /** The card body: open this tab (the browser area on it). */
  onOpen: () => void;
  /** The × beside the body (full cards); closing needs no confirmation. */
  onClose?: () => void;
  closeLabel?: string;
}

const TAG_TONE: Partial<Record<LiveTabState, TagTone>> = { held: "neutral", attention: "warning", error: "danger" };

/** The card's accessible name: the title, then the state. */
export function liveTabLabel({ title, stateLabel, state }: Pick<LiveTabCardProps, "title" | "stateLabel" | "state">): string {
  return stateLabel && state && state !== "idle" ? `${title} · ${stateLabel}` : title;
}

/** The state mark of the title row: the thinking mark while busy, a Tag for held, attention and error. */
export function LiveTabStateMark({ state = "idle", stateLabel, size = "sm" }: Pick<LiveTabCardProps, "state" | "stateLabel"> & { size?: "xs" | "sm" }) {
  if (state === "busy") return <span className={styles.mark} aria-hidden="true"><ButlerThinkingMark state="working" size={size} /></span>;
  const tone = TAG_TONE[state];
  return tone && stateLabel ? <span className={styles.state}><Tag tone={tone}>{stateLabel}</Tag></span> : null;
}

/**
 * A live Butler tab: favicon, title, state and ×, over a 16:10 frame drawn
 * from a passed bitmap or picture. The body opens the tab; the × and the
 * band's and overlay's buttons sit beside it, never inside it.
 */
export function LiveTabCard(props: LiveTabCardProps) {
  const { title, favicon, frame, state = "idle", stateLabel, needsYou, failure, variant = "full", onOpen, onClose, closeLabel } = props;
  if (variant === "compact") return <LiveTabCompact {...props} />;
  if (variant === "chip") return <LiveTabChip {...props} />;
  return (
    <div className={styles.card} data-slot="live-tab-card" data-variant="full" data-state={state}>
      <Clickable className={dsClass(styles.body)} stretch onClick={onOpen} aria-label={liveTabLabel(props)}>
        <span className={styles.head}>
          <SiteIcon src={favicon} />
          <Typo.Caption className={dsClass(styles.title)} weight="medium" tone="primary" truncate>{title}</Typo.Caption>
          <LiveTabStateMark state={state} stateLabel={stateLabel} />
        </span>
        <LiveTabFrame frame={frame} favicon={favicon} dimmed={state === "error"} />
      </Clickable>
      {onClose && closeLabel ? (
        <span className={styles.close}>
          <IconButton label={closeLabel} onClick={onClose}><X size="sm" /></IconButton>
        </span>
      ) : null}
      {state === "attention" && needsYou ? (
        <span className={styles.band} data-slot="live-tab-band">
          <Typo.Caption className={dsClass(styles.bandText)} tone="warning" weight="medium" truncate>{needsYou.detail}</Typo.Caption>
          <Button size="xs" onClick={needsYou.action.onAction}>{needsYou.action.label}</Button>
        </span>
      ) : null}
      {state === "error" && failure ? (
        <span className={styles.failure} data-slot="live-tab-failure">
          <span className={styles.failurePlate}>
            <Typo.Caption weight="medium" tone="secondary">{failure.label}</Typo.Caption>
            {failure.action ? <Button size="xs" variant="secondary" onClick={failure.action.onAction}>{failure.action.label}</Button> : null}
          </span>
        </span>
      ) : null}
    </div>
  );
}
