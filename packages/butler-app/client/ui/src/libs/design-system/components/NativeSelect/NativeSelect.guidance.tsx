import type { ShowcaseGuidance } from "../../showcase";
import { Field, FieldLabel } from "../Field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../Select";
import { NativeSelect, NativeSelectOption } from "./NativeSelect";

// #region recipe: Transport field
function TransportField() {
  return (
    <Field>
      <FieldLabel htmlFor="transport">Transport</FieldLabel>
      <NativeSelect id="transport" defaultValue="stdio">
        <NativeSelectOption value="stdio">stdio</NativeSelectOption>
        <NativeSelectOption value="http">HTTP</NativeSelectOption>
      </NativeSelect>
    </Field>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A styled native <select>: the platform picker, with the Butler trigger look.",
  whenToUse: ["Pick one value in a dense form or a secret row", "Mobile-friendly choice where the OS picker is best"],
  whenNotToUse: [
    { when: "Options need icons, descriptions or custom rendering", use: "Select" },
    { when: "Searching a long list", use: "FilteredSelectPopover" },
    { when: "Two to four visible choices", use: "SegmentedControl" },
  ],
  recipes: [{ name: "Transport field", description: "Inside a Field with a FieldLabel bound by id.", render: () => <TransportField /> }],
  doDont: [
    {
      do: { caption: "Plain text options: the native picker is fast and accessible.", render: () => <TransportField /> },
      dont: {
        caption: "A Radix Select for two plain options adds weight without benefit in dense rows.",
        render: () => (
          <Select defaultValue="stdio">
            <SelectTrigger aria-label="Transport"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="stdio">stdio</SelectItem></SelectContent>
          </Select>
        ),
      },
    },
  ],
  content: ["Option labels are short and parallel (Literal value / Environment variable / Keychain)."],
  accessibility: ["Name it with a label or aria-label; the visible value mirrors the selected option."],
  tokens: ["--control-height-md", "--radius-control", "--line", "--focus-ring"],
};
