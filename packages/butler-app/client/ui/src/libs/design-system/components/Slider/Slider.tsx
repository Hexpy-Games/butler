import type { CSSProperties, InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils";
import styles from "./Slider.module.css";

export interface SliderProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "onChange"
> {
  value: number;
  min: number;
  max: number;
  step?: number;
  onValueChange?: (value: number) => void;
}

export function Slider({
  className,
  max,
  min,
  onValueChange,
  step = 1,
  value,
  ...props
}: SliderProps) {
  const percentage = max > min ? ((value - min) / (max - min)) * 100 : 0;
  const sliderStyle = {
    ...props.style,
    "--slider-value": `${Math.max(0, Math.min(100, percentage))}%`,
  } as CSSProperties;

  return (
    <input
      {...props}
      className={cn(styles.slider, className)}
      data-slot="slider"
      max={max}
      min={min}
      onChange={(event) => onValueChange?.(Number(event.currentTarget.value))}
      step={step}
      style={sliderStyle}
      type="range"
      value={value}
    />
  );
}
