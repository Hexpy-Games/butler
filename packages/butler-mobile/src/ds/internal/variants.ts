import { alpha } from "../../design/tokens";
import type { Tokens } from "../../design/tokens";

export type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "destructive";

export interface VariantColors { background: string; foreground: string; border: string }

export function disabledColors(t: Tokens, variant: ButtonVariant): VariantColors {
  return {
    background: variant === "ghost" ? "transparent" : t.color("--color-disabled-bg"),
    foreground: t.color("--interactive-disabled-fg"),
    border: "transparent",
  };
}

/** Fill, label and border colours of a Button variant (web button.tsx, touch size). */
export function variantColors(t: Tokens, variant: ButtonVariant): VariantColors {
  switch (variant) {
    case "default":
      return { background: t.color("--primary"), foreground: t.color("--primary-foreground"), border: "transparent" };
    case "secondary":
      return { background: t.color("--secondary"), foreground: t.color("--secondary-foreground"), border: t.color("--secondary-border") };
    case "outline":
      return { background: alpha(t.color("--surface-raised"), 0.86), foreground: t.color("--text-primary"), border: t.color("--line") };
    case "ghost":
      return { background: "transparent", foreground: t.color("--text-primary"), border: "transparent" };
    case "destructive":
      return { background: alpha(t.color("--danger"), 0.12), foreground: t.color("--danger"), border: "transparent" };
  }
}
