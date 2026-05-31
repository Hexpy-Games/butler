import { Input } from "../../components/Input";
import { Stack } from "../../components/Stack";
import { ProgressMeter } from "../ProgressMeter";
import styles from "./PercentInputControl.module.css";

export interface PercentInputControlProps {
  id?: string;
  value: number;
  min?: number;
  max?: number;
  onChange?: (value: number) => void;
}

export function PercentInputControl({
  id,
  value,
  min = 0,
  max = 100,
  onChange,
}: PercentInputControlProps) {
  return (
    <Stack gap="xs" className={styles.root}>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange?.(Number(event.target.value))}
      />
      <ProgressMeter label="Preview" value={value} />
    </Stack>
  );
}
