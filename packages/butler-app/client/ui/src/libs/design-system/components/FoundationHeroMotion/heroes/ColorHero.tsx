import { type CSSProperties } from "react";
import { cn } from "../../../lib/utils";
import { HeroReadout } from "./HeroReadout";
import v from "../heroVariants.module.css";

/** Neutral roles, the accent and the status colors, in reading order. */
const COLOR_ROLES = ["--text-primary", "--text-secondary", "--text-tertiary", "--line-strong", "--accent", "--color-success", "--color-warning", "--color-danger", "--color-info-bg"];

/**
 * 01 Color: role swatches step across a light pane into a dark pane. The same
 * strip is drawn in both theme scopes, so each role recolors exactly where it
 * crosses the seam.
 */
export function ColorHero() {
  const strip = (
    <span className={v.colorStrip}>
      {[...COLOR_ROLES, ...COLOR_ROLES].map((role, index) => (
        <span className={v.colorBar} key={`${role}-${index}`} style={{ "--bar": `var(${role})` } as CSSProperties} />
      ))}
    </span>
  );
  return (
    <>
      <span className={cn(v.colorPane, "theme-light")} data-pane="light">
        <span className={v.colorTrack}>{strip}</span>
        <span className={v.paneLabel}>.theme-light</span>
        {/* Step k carries swatch 4 + k across the seam; the readout names that role. */}
        <HeroReadout slots={9} items={COLOR_ROLES.map((_, k) => COLOR_ROLES[(4 + k) % COLOR_ROLES.length]!)} />
      </span>
      <span className={cn(v.colorPane, "theme-dark")} data-pane="dark">
        <span className={v.colorTrack}>{strip}</span>
        <span className={v.paneLabel}>.theme-dark</span>
      </span>
    </>
  );
}
