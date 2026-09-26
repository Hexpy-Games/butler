import type { HTMLAttributes, ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import styles from "./EventTimeline.module.css";

export interface EventTimelineProps extends DsBaseProps<HTMLAttributes<HTMLDivElement>> {
  /** `EventTimelineItem`s, newest first. */
  children: ReactNode;
}

/** A vertical run of dated events; each item's marker is joined to the next by a hairline. */
export function EventTimeline({ children, className, ...props }: EventTimelineProps) {
  return <div className={dsClass(styles.timeline, className)} {...props}>{children}</div>;
}

export interface EventTimelineItemProps {
  /** The event-kind icon, centered in the marker column (tertiary tone). */
  marker: ReactNode;
  /** One node: the event content (usually a Stack with a NavRow). */
  children: ReactNode;
}

/** One event: marker column and content; the connector runs to the next item. */
export function EventTimelineItem({ marker, children }: EventTimelineItemProps) {
  return (
    <div className={styles.event} data-slot="event-timeline-item">
      <div className={styles.marker} data-slot="event-timeline-marker">{marker}</div>
      {children}
    </div>
  );
}
