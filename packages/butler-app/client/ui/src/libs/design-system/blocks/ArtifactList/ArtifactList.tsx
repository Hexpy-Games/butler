import type {
  HTMLAttributes,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
} from "react";
import { Button } from "../../components/Button";
import { FileText } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./ArtifactList.module.css";

export interface ArtifactListAction {
  id: string;
  label: string;
  ariaLabel?: string;
  href?: string;
  download?: string;
  icon?: ReactNode;
  onClick?: () => void;
}

export interface ArtifactListItem {
  id: string;
  title: string;
  description?: string;
  icon?: ReactNode;
  ariaLabel?: string;
  actions?: ArtifactListAction[];
  onOpen?: () => void;
}

export interface ArtifactListProps extends HTMLAttributes<HTMLDivElement> {
  items: ArtifactListItem[];
}

export function ArtifactList({
  items,
  className,
  ...props
}: ArtifactListProps) {
  if (items.length === 0) return null;

  return (
    <div className={cn(styles.list, className)} {...props}>
      {items.map((item) => (
        <ArtifactListRow item={item} key={item.id} />
      ))}
    </div>
  );
}

function ArtifactListRow({ item }: { item: ArtifactListItem }) {
  const actions = item.actions ?? [];
  const isClickable = Boolean(item.onOpen);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!item.onOpen) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    item.onOpen();
  };
  const content = (
    <>
      <span className={styles.icon} aria-hidden="true">
        {item.icon ?? <FileText size={20} />}
      </span>
      <span className={styles.text}>
        <Typo.Body as="span" className={styles.title}>
          {item.title}
        </Typo.Body>
        {item.description ? (
          <Typo.Caption className={styles.description}>
            {item.description}
          </Typo.Caption>
        ) : null}
      </span>
      {actions.length > 0 ? (
        <span className={styles.actions}>
          {actions.map((action) => (
            <ArtifactListActionButton action={action} key={action.id} />
          ))}
        </span>
      ) : null}
    </>
  );

  return (
    <div
      aria-label={item.ariaLabel ?? item.title}
      className={cn(styles.row, isClickable && styles.buttonRow)}
      role={isClickable ? "button" : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onClick={item.onOpen}
      onKeyDown={handleKeyDown}
    >
      {content}
    </div>
  );
}

function ArtifactListActionButton({ action }: { action: ArtifactListAction }) {
  const handleClick = (
    event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    action.onClick?.();
  };

  if (action.href) {
    return (
      <Button asChild size="sm" variant="outline">
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
      size="sm"
      text={action.label}
      type="button"
      variant="outline"
      onClick={handleClick}
    />
  );
}
