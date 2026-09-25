import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Card } from "../../components/Card";
import { Inline } from "../../components/Inline";
import { Stack } from "../../components/Stack";
import { Tag } from "../../components/Tag";
import { Typo } from "../../components/Typo";
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
  actionLabel,
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
  const secondLine = [description, meta].filter(Boolean).join(" · ");
  const content = (
    <div className={styles.body}>
      {icon ? (
        <span className={styles.icon} data-slot="document-tile-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <Stack gap="xs" className={styles.copy}>
        <Typo.Body weight="medium" lineClamp={2} wrap="anywhere" title={title}>
          {title}
        </Typo.Body>
        {badge || secondLine ? (
          <Inline gap="xs" wrap={false} className={styles.meta}>
            {badge ? <Tag data-test-class="document-tile-badge">{badge}</Tag> : null}
            {secondLine ? <Typo.Caption tone="secondary" truncate>{secondLine}</Typo.Caption> : null}
          </Inline>
        ) : null}
      </Stack>
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
