import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { Inline } from "../../components/Inline";
import { Stack } from "../../components/Stack";
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
  /**
   * Read-only facts the action is about (a `SurfacePanel elevation="subtle"`
   * facts card), between the description and the action.
   */
  details?: ReactNode;
}

/**
 * A settings action row: label, a one-line description of the effect and its
 * consequence, and the button in the control slot under them. An action never
 * sits beside a section title. Facts the action works on go in `details`
 * (above the button), progress in `afterControl`, other facts in `meta`.
 */
export function SettingsActionField({ action, details, ...props }: SettingsActionFieldProps) {
  const control = details ? <ActionWithDetails details={details} action={action} /> : action;
  return <SettingsField data-settings-action-field="" {...props} control={control} />;
}

interface ActionWithDetailsProps {
  details: ReactNode;
  action: ReactElement;
  /** Set by SettingsField; forwarded to the action, so the description still describes the button. */
  "aria-describedby"?: string;
}

/** Details, then the action, at the field's control gap (Stack "sm" = --settings-field-control-gap). */
function ActionWithDetails({ details, action, "aria-describedby": describedBy }: ActionWithDetailsProps) {
  return (
    <Stack gap="sm">
      {details}
      <Inline>{describeAction(action, describedBy)}</Inline>
    </Stack>
  );
}

function describeAction(action: ReactElement, describedBy: string | undefined): ReactElement {
  if (!describedBy || !isValidElement<{ "aria-describedby"?: string }>(action)) return action;
  const own = action.props["aria-describedby"]?.split(/\s+/u) ?? [];
  const ids = [...new Set([...own, ...describedBy.split(/\s+/u)])].filter(Boolean).join(" ");
  return cloneElement(action, { "aria-describedby": ids });
}
