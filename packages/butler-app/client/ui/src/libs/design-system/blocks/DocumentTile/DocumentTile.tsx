import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Card } from "../../components/Card";
import { ResourceSummary } from "../ResourceSummary";
import styles from "./DocumentTile.module.css";

export interface DocumentTileAction {
  id: string;
  label: string;
  ariaLabel?: string;
  href?: string;
  download?: string;
  icon?: ReactNode;
  onClick?: () => void;
}

export interface DocumentTileProps {
  title: string;
  description?: string;
  meta?: string;
  badge?: string;
  icon?: ReactNode;
  actions?: DocumentTileAction[];
  actionLabel?: string;
  actionHref?: string;
  actionTarget?: string;
  ariaLabel?: string;
  clickTarget?: "action" | "tile";
  onOpen?: () => void;
}

export function DocumentTile({
  title,
  description,
  meta,
  badge,
  icon,
  actions = [],
  actionLabel = "Open",
  actionHref,
  actionTarget,
  ariaLabel,
  clickTarget = "action",
  onOpen,
}: DocumentTileProps) {
  const rel = actionTarget === "_blank" ? "noreferrer" : undefined;
  const hasActions = actions.length > 0;
  const isTileClickable = clickTarget === "tile" && Boolean(onOpen);
  const handleTileKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isTileClickable || !onOpen) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpen();
  };
  const content = (
    <div className={styles.contentWrap}>
      {icon || badge ? (
        <span className={styles.marker}>
          {icon ? (
            <span
              className={styles.icon}
              data-slot="document-tile-icon"
              aria-hidden="true"
            >
              {icon}
            </span>
          ) : null}
          {badge ? (
            <span className={styles.badge} data-slot="document-tile-badge">
              {badge}
            </span>
          ) : null}
        </span>
      ) : null}
      <ResourceSummary
        className={styles.content}
        title={title}
        description={description}
        meta={meta}
      />
    </div>
  );

  return (
    <Card
      aria-label={isTileClickable ? (ariaLabel ?? actionLabel) : undefined}
      className={styles.tile}
      data-slot="document-tile"
      interactive={isTileClickable}
      role={isTileClickable ? "button" : undefined}
      tabIndex={isTileClickable ? 0 : undefined}
      onClick={isTileClickable ? onOpen : undefined}
      onKeyDown={handleTileKeyDown}
    >
      {content}
      {hasActions ? (
        <ButtonContainer className={styles.actions} size="xs">
          {actions.map((action) => (
            <DocumentTileActionButton action={action} key={action.id} />
          ))}
        </ButtonContainer>
      ) : !isTileClickable && actionHref ? (
        <Button asChild size="xs" variant="borderless">
          <a href={actionHref} target={actionTarget} rel={rel}>
            {actionLabel}
          </a>
        </Button>
      ) : !isTileClickable && onOpen ? (
        <Button size="xs" variant="borderless" onClick={onOpen}>
          {actionLabel}
        </Button>
      ) : null}
    </Card>
  );
}

function DocumentTileActionButton({ action }: { action: DocumentTileAction }) {
  const handleClick = (
    event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    action.onClick?.();
  };

  if (action.href) {
    return (
      <Button asChild size="xs" variant="outline">
        <a
          aria-label={action.ariaLabel ?? action.label}
          download={action.download}
          href={action.href}
          onClick={handleClick}
        >
          {action.icon ? (
            <span className={styles.actionIcon}>{action.icon}</span>
          ) : null}
          {action.label}
        </a>
      </Button>
    );
  }

  return (
    <Button
      aria-label={action.ariaLabel ?? action.label}
      iconStart={action.icon}
      size="xs"
      text={action.label}
      type="button"
      variant="outline"
      onClick={handleClick}
    />
  );
}
