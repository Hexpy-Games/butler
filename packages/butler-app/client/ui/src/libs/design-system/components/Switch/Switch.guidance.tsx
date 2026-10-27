import type { ShowcaseGuidance } from "../../showcase";
import { SettingsField, SettingsFieldScopeProvider } from "../../blocks/SettingsField";
import { Button } from "../Button";
import { Card } from "../Card";
import { Field, FieldContent, FieldDescription, FieldLabel } from "../Field";
import { Stack } from "../Stack";
import { Switch } from "./Switch";

// #region recipe: Settings toggle
function SettingsToggle() {
  return (
    <SettingsFieldScopeProvider>
      <SettingsField id="backup-models" label="Use backup models" description="Retry with the next model when the main one fails."
        control={<Switch id="backup-models" defaultChecked />} />
    </SettingsFieldScopeProvider>
  );
}
// #endregion

// #region recipe: Setting unavailable on this device
function UnavailableToggle() {
  return (
    <SettingsFieldScopeProvider>
      <SettingsField id="command-sandbox" label="Command sandbox" description="Runs commands that change files in an isolated environment."
        control={<Switch id="command-sandbox" checked={false} disabledReason="Not available on this device" />} />
    </SettingsFieldScopeProvider>
  );
}
// #endregion

// #region recipe: Row switch field (a phone, or a list item in a card)
function RowToggle() {
  return (
    <Card padding="md">
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="all-conversations">Use in every conversation</FieldLabel>
          <FieldDescription>Butler signs in without asking.</FieldDescription>
        </FieldContent>
        <Switch id="all-conversations" />
      </Field>
    </Card>
  );
}
// #endregion

/** The row layout used where it does not belong: a desktop settings field. */
function DesktopRowToggle() {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor="backup-row">Use backup models</FieldLabel>
        <FieldDescription>Retry with the next model when the main one fails.</FieldDescription>
      </FieldContent>
      <Switch id="backup-row" defaultChecked />
    </Field>
  );
}

export const guidance: ShowcaseGuidance = {
  purpose: "An on/off setting that takes effect immediately.",
  whenToUse: ["Turn a setting on or off; it applies as soon as it is flipped, without a save step"],
  whenNotToUse: [
    { when: "Choosing among more than two states or modes", use: "SegmentedControl" },
    { when: "Selecting items, or a choice confirmed with a submit button", use: "CheckCard" },
    { when: "An action that runs once", use: "Button" },
  ],
  recipes: [
    {
      name: "Settings toggle",
      description: "Placement, the default (stacked): like an input, the label, its description, then the switch underneath, left-aligned. Every desktop settings field and form.",
      render: () => <SettingsToggle />,
    },
    {
      name: "Row switch field (a phone, or a list item in a card)",
      description: "Placement, the exception (row): Field orientation=\"horizontal\", the label and switch on one row with the switch at the row end and the description under the label. Only on a phone or for a list item inside a closed container (a card, a list row).",
      render: () => <RowToggle />,
    },
    {
      name: "Setting unavailable on this device",
      description: "disabledReason names why; hover or focus opens it to the right of the switch, clear of the label and description.",
      render: () => <UnavailableToggle />,
    },
  ],
  doDont: [
    {
      do: { caption: "Stacked (default): the switch under its label and description.", render: () => <SettingsToggle /> },
      dont: { caption: "Row on a desktop settings page: the row layout is only for a phone or a list item in a card.", render: () => <DesktopRowToggle /> },
    },
    {
      do: { caption: "Row (exception): a list item in a card keeps the switch at the row end.", render: () => <RowToggle /> },
      dont: {
        caption: "Any layout with the switch before its label.",
        render: () => <Stack align="row" cross="center" gap="sm"><Switch id="switch-first" /><FieldLabel htmlFor="switch-first">Use backup models</FieldLabel></Stack>,
      },
    },
    {
      do: { caption: "The switch changes state right away; the label names the setting.", render: () => <SettingsToggle /> },
      dont: { caption: "A button that toggles text (Enable/Disable) hides the current state.", render: () => <Button variant="outline" text="Enable backup models" /> },
    },
  ],
  content: [
    "Placement: stacked by default (label, description, switch underneath, left-aligned). The row layout (Field orientation=\"horizontal\") only on a phone or for a list item inside a card or list row. Never before its label.",
    "Usage: an immediate on/off that applies when flipped. Selections, or choices confirmed with a submit button, take a checkbox (CheckCard); more than two states take SegmentedControl.",
    "A disabled switch says why: disabledReason opens a tooltip with the reason.",
    "lint:ds (switch-field-layout) flags a Switch beside a label in a Stack or Inline row; use Field orientation=\"horizontal\" where the row layout is allowed.",
    "Name the setting, not the action: Use backup models, not Turn on backup models.",
    "disabledReason is a few words (Follows the system setting), never an explanation paragraph.",
    "The reason opens to the right of the switch (disabledReasonSide, default right; disabledReasonAlign, default center). Change it only when something the reader needs sits to the right.",
  ],
  accessibility: [
    "role=switch with aria-checked; bind the label with id, and the description with aria-describedby.",
    "disabledReason keeps the switch focusable (aria-disabled) so keyboard and pointer users can read the reason tooltip.",
    "A tap on a touch screen does not open the reason tooltip yet.",
  ],
  tokens: ["--switch-track-bg", "--switch-thumb", "--accent", "--motion-ease-spring", "--motion-base"],
};
