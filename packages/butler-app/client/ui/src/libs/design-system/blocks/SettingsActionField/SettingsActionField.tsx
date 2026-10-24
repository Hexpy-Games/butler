import type { ReactElement, ReactNode } from "react";
import { SettingsField, type SettingsFieldProps } from "../SettingsField";

export interface SettingsActionFieldProps extends Omit<SettingsFieldProps, "control" | "controlWidth" | "description"> {
  /** What the action does and what it changes, in one short line. */
  description: ReactNode;
  /**
   * The action: one Button (or a ButtonContainer when two actions act on the
   * same thing, View and Clear). The caller keeps its confirm dialog and its
   * disabled tooltip.
   */
  action: ReactElement;
}

/**
 * A settings action row: label, a one-line description of the effect and its
 * consequence, and the button in the control slot under them. An action never
 * sits beside a section title. Progress goes in `afterControl`, facts about what the
 * action affects in `meta`.
 */
export function SettingsActionField({ action, ...props }: SettingsActionFieldProps) {
  return <SettingsField data-settings-action-field="" {...props} control={action} />;
}
