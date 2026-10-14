import type { ReactNode } from "react";
import { Clickable } from "../../components/Clickable";
import { Collapsible } from "../../components/Collapsible";
import { ChevronRight, ChevronUpIcon } from "../../components/Icons";
import { RollingSwap } from "../../components/RollingSwap";
import { Tag } from "../../components/Tag";
import { Typo } from "../../components/Typo";
import { dsClass } from "../../lib/internal";
import blockStyles from "./WorkActivityBlock.module.css";
import styles from "./WorkActivityDisclosure.module.css";

export interface WorkActivityDisclosureProps {
  /** The run state line ("Working", "Done"). */
  status: ReactNode;
  /** The newest activity, one line. Collapsed, it is the tail's timeline row. */
  latest: ReactNode;
  /** The activity before it: one line fading toward the top, above the latest row. */
  previous?: ReactNode;
  /** Records inside beyond the latest one; shown as the "+N ›" Tag. */
  hiddenCount: number;
  /** The work is still running: the latest dot pulses (static under reduced motion). */
  live?: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** Accessible name of the toggle: status, latest activity and the hidden count. */
  label: string;
  /** Id of the details region the toggle controls. */
  detailsId: string;
  /** Accessible name of the details region. */
  detailsLabel: string;
  /** The full timeline, bounded by the caller (ScrollArea maxHeight="sm"). */
  children: ReactNode;
  "data-test-class"?: string;
}

/**
 * A work timeline folded to its tail. Collapsed, the status line and the tail
 * (the previous activity fading upward, the latest activity on the timeline
 * dot and line, and a "+N ›" count) are one disclosure button. Expanded, the
 * tail folds away so only the full timeline remains, and a collapse chevron
 * marks the status line as the way back.
 */
export function WorkActivityDisclosure({
  status,
  latest,
  previous,
  hiddenCount,
  live = false,
  expanded,
  onToggle,
  label,
  detailsId,
  detailsLabel,
  children,
  "data-test-class": dataTestClass,
}: WorkActivityDisclosureProps) {
  return (
    <div className={styles.root} data-expanded={expanded || undefined} data-test-class={dataTestClass}>
      <Clickable
        aria-controls={expanded ? detailsId : undefined}
        aria-expanded={expanded}
        aria-label={label}
        className={dsClass(styles.toggle)}
        data-test-class="work-activity-disclosure-toggle"
        onClick={onToggle}
        stretch
        variant="text"
      >
        <span className={styles.statusRow}>
          <Typo.Caption as="span" data-test-class="work-activity-disclosure-status" grow minWidth="0" truncate>
            {status}
          </Typo.Caption>
          <span className={styles.collapseIcon} aria-hidden="true" data-slot="work-activity-collapse-icon">
            <ChevronUpIcon size="sm" />
          </span>
        </span>
        <Collapsible aria-hidden="true" data-test-class="work-activity-tail" open={!expanded}>
          <RollingSwap itemKey={String(hiddenCount)} motion={live}>
            <span className={styles.tail} data-has-previous={previous ? "true" : undefined}>
              {previous ? (
                <span className={styles.row} data-row="previous" data-test-class="work-activity-tail-previous">
                  <span className={`${blockStyles.marker} ${styles.dot}`} />
                  <Typo.Caption as="span" grow minWidth="0" tone="secondary" truncate>{previous}</Typo.Caption>
                </span>
              ) : null}
              <span className={styles.row} data-row="latest" data-test-class="work-activity-tail-latest">
                <span
                  className={`${blockStyles.marker} ${styles.dot}`}
                  data-live={live || undefined}
                  data-slot="work-activity-marker"
                />
                <Typo.Caption as="span" grow minWidth="0" tone="secondary" truncate>{latest}</Typo.Caption>
                <span className={styles.count} data-test-class="work-activity-tail-count">
                  {hiddenCount > 0 ? (
                    <Tag iconEnd={<ChevronRight size="xs" />}>{`+${hiddenCount}`}</Tag>
                  ) : (
                    <ChevronRight size="sm" />
                  )}
                </span>
              </span>
            </span>
          </RollingSwap>
        </Collapsible>
      </Clickable>
      <Collapsible aria-label={detailsLabel} data-test-class="work-activity-details" id={detailsId} open={expanded} role="region">
        <div className={styles.details}>{children}</div>
      </Collapsible>
    </div>
  );
}
