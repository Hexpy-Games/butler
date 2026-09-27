import { useRef } from "react";
import { ButlerThinkingMark } from "../../components/ButlerThinkingMark";
import { useBrandActivity } from "../hooks/useBrandActivity";
import { useSiteTheme } from "../hooks/useSiteTheme";
import styles from "./BrandMark.module.css";

export interface BrandMarkProps {
  /** lg: header lockup; hero: the docs home header. */
  size?: "lg" | "hero";
  /** Think for a moment after appearing (reduced motion: a brief breathe). */
  intro?: boolean;
}

/**
 * Brand island: the ThinkingMark follows the page theme and thinks while its
 * link (or [data-mark-hover] area) is hovered or focused, or while a search runs.
 */
export function BrandMark({ size = "lg", intro = false }: BrandMarkProps) {
  const anchor = useRef<HTMLSpanElement | null>(null);
  const working = useBrandActivity(anchor, intro);
  const theme = useSiteTheme();
  return (
    <span className={styles.anchor} data-size={size} ref={anchor}>
      <ButlerThinkingMark size={size === "lg" ? "lg" : undefined} state={working ? "working" : "idle"} theme={theme} />
    </span>
  );
}
