import type { HTMLAttributes, ReactNode } from "react";
import { ListChecks, PencilLine, Trash2 } from "../../components/Icons";
import { ButtonContainer } from "../../components/ButtonContainer";
import { IconButton } from "../../components/IconButton";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import { ComposerAdjunctPanel } from "../ComposerAdjunctPanel";
import { NavRow } from "../NavRow";
import styles from "./ComposerQueuePanel.module.css";

export interface ComposerQueuePanelItem {
  id: string;
  label: ReactNode;
  badge?: ReactNode;
  ariaLabel?: string;
  indexLabel?: ReactNode;
}

export interface ComposerQueuePanelProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "title"
> {
  heading: ReactNode;
  items: ComposerQueuePanelItem[];
  editLabel: string;
  deleteLabel: string;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  ariaLabel?: string;
}

export function ComposerQueuePanel({
  heading,
  items,
  editLabel,
  deleteLabel,
  onEdit,
  onDelete,
  ariaLabel,
  className,
  ...props
}: ComposerQueuePanelProps) {
  if (items.length === 0) return null;

  return (
    <ComposerAdjunctPanel
      role="region"
      className={cn(styles.panel, className)}
      aria-label={
        ariaLabel ?? (typeof heading === "string" ? heading : undefined)
      }
      heading={heading}
      icon={<ListChecks size={15} />}
      {...props}
    >
      <div className={styles.list}>
        {items.map((item, index) => (
          <NavRow
            key={item.id}
            dataTestClass="queued-message-row"
            icon={
              <Typo.Caption as="span">
                {item.indexLabel ?? index + 1}
              </Typo.Caption>
            }
            label={item.label}
            badge={item.badge}
            ariaLabel={item.ariaLabel}
            actions={
              <ButtonContainer size="icon-sm">
                <IconButton label={editLabel} onClick={() => onEdit(item.id)}>
                  <PencilLine size={14} />
                </IconButton>
                <IconButton
                  label={deleteLabel}
                  onClick={() => onDelete(item.id)}
                >
                  <Trash2 size={14} />
                </IconButton>
              </ButtonContainer>
            }
          />
        ))}
      </div>
    </ComposerAdjunctPanel>
  );
}
