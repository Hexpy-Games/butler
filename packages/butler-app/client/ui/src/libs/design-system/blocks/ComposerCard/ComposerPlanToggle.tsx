import type { ReactNode } from "react";
import { Switch } from "../../components/Switch";
import styles from "./ComposerCard.module.css";

export function ComposerPlanToggle({
  checked,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  label: ReactNode;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className={styles.planToggle} data-test-class="plan-switch">
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
      <span>{label}</span>
    </label>
  );
}
