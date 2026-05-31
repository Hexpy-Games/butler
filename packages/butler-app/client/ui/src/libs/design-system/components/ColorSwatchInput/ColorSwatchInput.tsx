import type { ComponentPropsWithoutRef } from "react";
import styles from "./ColorSwatchInput.module.css";

interface ColorSwatchInputProps extends Omit<
  ComponentPropsWithoutRef<"input">,
  "className" | "type"
> {
  dataTestClass?: string;
}

export function ColorSwatchInput({
  dataTestClass,
  ...props
}: ColorSwatchInputProps) {
  return (
    <span className={styles.root} data-slot="color-swatch-input">
      <input
        {...props}
        className={styles.input}
        data-test-class={dataTestClass}
        type="color"
      />
    </span>
  );
}
