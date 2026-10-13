import { Button } from "../../components/Button";
import { ButlerThinkingMark } from "../../components/ButlerThinkingMark";
import { Clickable } from "../../components/Clickable";
import { Tooltip } from "../../components/Tooltip";
import { Typo } from "../../components/Typo";
import { dsClass } from "../../lib/internal";
import { SiteIcon } from "../../lib/SiteIcon";
import { liveTabLabel, type LiveTabCardProps } from "./LiveTabCard";
import { LiveTabFrame } from "./LiveTabFrame";
import styles from "./LiveTabCard.module.css";

/** The compact corner mark: the thinking mark while busy, an amber or red dot when the tab needs the user or failed. */
function CornerMark({ state }: Pick<LiveTabCardProps, "state">) {
  if (state === "busy") return <span className={styles.corner} aria-hidden="true"><ButlerThinkingMark state="working" size="xs" /></span>;
  if (state !== "attention" && state !== "error") return null;
  return <span className={styles.corner} aria-hidden="true"><span className={styles.dot} data-tone={state} /></span>;
}

/**
 * A 128×80 thumbnail with no title row: the title is the tooltip and the
 * accessible name; the favicon sits on the bottom-start corner, the state on
 * the top-end corner. A needs-you tab adds an xs action under the frame.
 */
export function LiveTabCompact(props: LiveTabCardProps) {
  const { title, favicon, frame, state = "idle", needsYou, onOpen } = props;
  return (
    <div className={styles.card} data-slot="live-tab-card" data-variant="compact" data-state={state}>
      <Tooltip label={title}>
        <Clickable className={dsClass(styles.body)} stretch onClick={onOpen} aria-label={liveTabLabel(props)}>
          <LiveTabFrame frame={frame} favicon={favicon} dimmed={state === "error"} />
          <span className={styles.favicon} aria-hidden="true"><SiteIcon src={favicon} /></span>
          <CornerMark state={state} />
        </Clickable>
      </Tooltip>
      {state === "attention" && needsYou ? (
        <Button size="xs" stretch onClick={needsYou.action.onAction}>{needsYou.action.label}</Button>
      ) : null}
    </div>
  );
}

/**
 * A shelf chip: a 48×30 live frame and the site name. A needs-you chip says
 * its action instead (열어서 확인) and runs it.
 */
export function LiveTabChip(props: LiveTabCardProps) {
  const { title, shortTitle, favicon, frame, state = "idle", needsYou, onOpen } = props;
  const action = state === "attention" ? needsYou?.action : undefined;
  return (
    <Clickable className={dsClass(styles.chip)} data-slot="live-tab-card" data-variant="chip" data-state={state}
      onClick={action ? action.onAction : onOpen} aria-label={liveTabLabel(props)} title={title}>
      <span className={styles.mini}><LiveTabFrame frame={frame} favicon={favicon} dimmed={state === "error"} /></span>
      {state === "busy" ? <span className={styles.mark} aria-hidden="true"><ButlerThinkingMark state="working" size="xs" /></span> : null}
      <Typo.Caption className={dsClass(styles.chipText)} weight="medium" tone={action ? "warning" : "primary"} truncate>
        {action ? action.label : shortTitle ?? title}
      </Typo.Caption>
    </Clickable>
  );
}
