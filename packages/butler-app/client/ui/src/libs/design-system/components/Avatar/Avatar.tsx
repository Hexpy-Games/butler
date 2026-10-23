import { useRef, type HTMLAttributes, type ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { cn } from "../../lib/utils";
import { usePresence } from "../Presence";
import { Tooltip } from "../Tooltip";
import { avatarInitials } from "./avatarInitials";
import styles from "./Avatar.module.css";

/** `xs` 16px: sidebar rows, cards, list rows. `sm` 20px: panel titles, activity rows. `md` 24px: headers. */
export type AvatarSize = "xs" | "sm" | "md";
/** `self`: the signed-in person (muted). `other`: anyone else (accent tint). */
export type AvatarTone = "self" | "other";

export interface AvatarProps extends DsBaseProps<HTMLAttributes<HTMLSpanElement>> {
  /** The person's display name; the initial and the default accessible name come from it. */
  name: string;
  /** Overrides the derived initial (one grapheme reads best). */
  initials?: string;
  size?: AvatarSize;
  tone?: AvatarTone;
  /**
   * Corner mark: a ~9px glyph shown while an agent works on the item for
   * this person. It pops in and fades out; `null`/`undefined` hides it.
   */
  badge?: ReactNode;
  /** Accessible name and tooltip, e.g. "Harin · Claude Code working". Defaults to `name` (no tooltip). */
  label?: string;
  /** Hidden from assistive tech when the name is already written beside it. */
  decorative?: boolean;
}

/** Keeps the last badge mounted through its exit transition. */
function AvatarBadge({ badge }: { badge: ReactNode }) {
  const present = badge !== null && badge !== undefined && badge !== false;
  const last = useRef<ReactNode>(badge);
  if (present) last.current = badge;
  const { mounted, state, ref } = usePresence(present);
  if (!mounted) return null;
  return (
    <span ref={ref} className={styles.badge} data-state={state} data-slot="avatar-badge" aria-hidden="true">
      {last.current}
    </span>
  );
}

/**
 * A person's initial in a small circle, shown right after an item's title
 * for its assignee. The optional badge marks an agent working for them.
 * The circle's box is always the size token; while a badge shows, an end
 * margin holds its overhang, so content after the avatar moves by that much.
 */
export function Avatar({
  name, initials, size = "xs", tone = "self", badge, label, decorative = false, className, ...props
}: AvatarProps) {
  const avatar = (
    <span
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : (label ?? name)}
      aria-hidden={decorative || undefined}
      className={cn(styles.avatar, className)}
      data-size={size}
      data-tone={tone}
      data-slot="avatar"
      {...props}
    >
      <span className={styles.initials} aria-hidden="true">{initials ?? avatarInitials(name)}</span>
      <AvatarBadge badge={badge} />
    </span>
  );
  return label && !decorative ? <Tooltip label={label}>{avatar}</Tooltip> : avatar;
}
