import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { ShieldCheck } from "../Icons";
import { ProviderLogo } from "../ProviderLogo";
import {
  Select, SelectButton, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectPillTrigger, SelectSeparator,
  SelectTrigger, SelectValue,
} from "./Select";

// #region recipe: Grouped theme select
function ThemeSelect() {
  return (
    <Select defaultValue="system">
      <SelectTrigger aria-label="Theme"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Follow</SelectLabel>
          <SelectItem value="system">System</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Fixed</SelectLabel>
          <SelectItem value="light">Light</SelectItem>
          <SelectItem value="dark">Dark</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
// #endregion

// #region recipe: Options with logos
function ProviderSelect() {
  const [value, setValue] = useState("anthropic");
  const options = [
    { value: "openai", label: "OpenAI", logo: "openai" },
    { value: "anthropic", label: "Anthropic", logo: "claude" },
  ] as const;
  const selected = options.find((option) => option.value === value) ?? options[0];
  return (
    <Select value={value} onValueChange={setValue}>
      <SelectTrigger aria-label="Provider">
        <SelectValue icon={<ProviderLogo name={selected.logo} />}>{selected.label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} icon={<ProviderLogo name={option.logo} />}>{option.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
// #endregion

// #region recipe: Composer pill select
function AccessPill() {
  const [value, setValue] = useState("ask");
  return (
    <Select value={value} onValueChange={setValue}>
      <SelectPillTrigger aria-label="Access" icon={<ShieldCheck size="sm" />}><SelectValue /></SelectPillTrigger>
      <SelectContent position="popper" side="top">
        <SelectItem value="ask">Ask first</SelectItem>
        <SelectItem value="full">Full access</SelectItem>
      </SelectContent>
    </Select>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A Radix select with the Butler trigger and menu, for one value from a list.",
  whenToUse: ["Choose one value with grouped or rich options", "A glass pill select in the composer"],
  whenNotToUse: [
    { when: "Plain options in a dense form or on phones", use: "NativeSelect" },
    { when: "A searchable list with filters", use: "FilteredSelectPopover" },
    { when: "A trigger that opens a custom popover", use: "SelectButton" },
  ],
  recipes: [
    { name: "Grouped theme select", description: "SelectGroup, SelectLabel and SelectSeparator structure long lists.", render: () => <ThemeSelect /> },
    { name: "Options with logos", description: "SelectItem icon puts a glyph before the option; SelectValue icon (with the value text as children) shows it in the trigger.", render: () => <ProviderSelect /> },
    { name: "Composer pill select", description: "SelectPillTrigger renders the glass PillButton trigger used by the composer.", render: () => <AccessPill /> },
  ],
  doDont: [
    {
      do: { caption: "Select shows its value in the default text color; placeholders are muted.", render: () => <ThemeSelect /> },
      dont: {
        caption: "A SelectButton without a popover is a button that promises a menu.",
        render: () => <SelectButton aria-label="Theme">System</SelectButton>,
      },
    },
  ],
  content: [
    "Option labels are nouns; the placeholder asks (Choose a model), it is not an option.",
    "Icons are optional and decorative: give every option one or none, so labels stay aligned.",
  ],
  accessibility: [
    "Name the trigger with aria-label or a Field label; typeahead and arrow keys work without motion delays.",
    "Select animates only its entrance (Radix unmounts it without an exit).",
    "Option and value icons are aria-hidden and sit outside the item text, so typeahead matches the label.",
  ],
  tokens: ["--control-height-md", "--menu-item-height", "--radius-popover", "--motion-enter-menu", "--motion-scale-menu", "--icon-size-md"],
  internalExports: {
    SelectScrollUpButton: "Rendered by SelectContent when the list overflows.",
    SelectScrollDownButton: "Rendered by SelectContent when the list overflows.",
  },
};
