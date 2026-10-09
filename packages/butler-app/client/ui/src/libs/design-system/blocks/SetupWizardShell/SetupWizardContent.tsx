import type { ReactNode } from "react";
import { Box } from "../../components/Box";
import { Stack } from "../../components/Stack";
import styles from "./SetupWizardShell.module.css";
import { dsClass } from "../../lib/internal";

export interface SetupWizardContentProps {
  children: ReactNode;
  /** Wizard: `default` 52ch, `wide` the full body. Focus: `default` 420px, `wide` 520px. */
  width?: "default" | "wide";
  /** Opaque content card over the wallpaper, with one shared token inset. */
  surface?: "solid";
}

export function SetupWizardContent({
  children,
  width = "default",
  surface,
}: SetupWizardContentProps) {
  const body = <Stack gap="lg">{children}</Stack>;
  return (
    <Box surface={surface === "solid" ? "raised-opaque" : undefined}
      elevation={surface === "solid" ? "card" : undefined} border={surface === "solid" ? "hairline" : undefined}
      radius={surface === "solid" ? "panel" : undefined} padding={surface === "solid" ? "lg" : undefined}
      className={dsClass(styles.content)} data-width={width} data-test-class="setup-wizard-content">
      {body}
    </Box>
  );
}

export function SetupWizardList({ children }: Pick<SetupWizardContentProps, "children">) {
  return (
    <Stack as="ul" className={dsClass(styles.list)} gap="sm">
      {children}
    </Stack>
  );
}
