import type { ReactNode } from "react";
import { Card } from "../../components/Card";
import { cn } from "../../lib/utils";
import { ResourceSummary } from "../ResourceSummary";
import styles from "./ResourceTile.module.css";

export interface ResourceTileProps {
  /** Icon element */
  icon?: ReactNode;
  /** Tile title */
  title: string;
  /** Optional description */
  description?: string;
  /** Optional metadata */
  meta?: string;
  /** Additional CSS class */
  className?: string;
}

export function ResourceTile({
  icon,
  title,
  description,
  meta,
  className,
}: ResourceTileProps) {
  return (
    <Card className={cn(styles.tile, className)}>
      <ResourceSummary
        icon={icon}
        title={title}
        description={description}
        meta={meta}
      />
    </Card>
  );
}
