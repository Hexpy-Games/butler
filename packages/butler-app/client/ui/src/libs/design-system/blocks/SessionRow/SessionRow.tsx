import type { ReactNode } from "react";
import { MessageSquare } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { NavRow } from "../NavRow";
import type { SidebarDensity } from "../SidebarShell/SidebarShell";
import styles from "./SessionRow.module.css";

export interface SessionRowProps {
  title: string;
  /** Second line (location, preview); switches the row to the two-line layout. */
  description?: string;
  /** Short status or time, joined after the description on the second line. */
  meta?: string;
  active?: boolean;
  /** Row actions (pin, menu); shown on hover like the sidebar. */
  actions?: ReactNode;
  card?: boolean;
  dataTestClass?: string;
  showIcon?: boolean;
  /** Session glyph; defaults to the sidebar conversation glyph. */
  icon?: ReactNode;
  onSelect?: () => void;
  /** Row density; omit inside a SidebarShell to follow the shell's density. */
  density?: SidebarDensity;
}

/**
 * The sidebar session row as a block: NavRow with the session glyph, a
 * truncated title and, when there is a second line, the flat-list layout
 * (two-line title clamp plus a caption line) used by Recent and Running.
 */
export function SessionRow({
  title,
  description,
  meta,
  active = false,
  actions,
  card = false,
  dataTestClass,
  showIcon = true,
  icon,
  onSelect,
  density,
}: SessionRowProps) {
  const secondLine = [description, meta].filter(Boolean).join(" · ");
  const row = (
    <NavRow
      dataTestClass={dataTestClass}
      icon={showIcon ? (icon ?? <MessageSquare />) : undefined}
      label={secondLine
        ? <Typo.Text lineClamp={2} wrap="anywhere" title={title}>{title}</Typo.Text>
        : <Typo.Text truncate title={title}>{title}</Typo.Text>}
      multiline={Boolean(secondLine)}
      meta={secondLine ? <Typo.Caption tone="secondary">{secondLine}</Typo.Caption> : undefined}
      active={active}
      ariaLabel={title}
      actions={actions}
      actionsVisibility="hover"
      onClick={onSelect}
      density={density}
    />
  );
  return card ? <div className={styles.card}>{row}</div> : row;
}
