import type { ReactNode } from "react";
import { Clock3 } from "../../components/Icons";
import { ListRow } from "../ListRow";
import { Notice } from "../Notice";
import { RowActionCluster } from "../RowActionCluster";
import styles from "./AutomationRow.module.css";

export interface AutomationRowProps {
  title: string;
  description?: string;
  automationTone?: "active" | "paused" | "error";
  automationLabel?: string;
  schedule?: string;
  actions?: ReactNode;
}

export function AutomationRow({
  title,
  description,
  automationTone = "active",
  automationLabel = automationTone,
  schedule,
  actions,
}: AutomationRowProps) {
  return (
    <div className={styles.row}>
      <ListRow
        icon={<Clock3 size={15} />}
        title={title}
        description={[schedule, description].filter(Boolean).join(" · ")}
      />
      {actions ? <RowActionCluster>{actions}</RowActionCluster> : null}
      <Notice
        tone={automationTone === "error" ? "error" : automationTone === "paused" ? "warning" : "success"}
        message={automationLabel}
      />
    </div>
  );
}
