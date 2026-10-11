import type { ShowcaseGuidance } from "../../showcase";
import { NavRow } from "../NavRow";
import { ICONS } from "../TabStrip/TabStrip.demo";
import { SuggestionList, SuggestionRow } from "./SuggestionList";

// #region recipe: Address suggestions
function AddressSuggestions() {
  // In the app: Popover open, PopoverAnchor around AddressField (listbox, onInputChange, onInputKeyDown),
  // PopoverContent width="anchor" density="list" holding this list.
  return (
    <SuggestionList id="address-suggestions" label="Address suggestions">
      <SuggestionRow id="address-suggestion-0" title="Docs - Getting started" url="https://docs.example.com/guides/getting-started"
        iconSrc={ICONS.docs} kind="bookmark" bookmarkLabel="Bookmarked" query="docs" active onSelect={() => undefined} />
      <SuggestionRow id="address-suggestion-1" title="Release notes" url="https://docs.example.com/changelog" iconSrc={ICONS.docs}
        query="docs" onSelect={() => undefined} />
    </SuggestionList>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The listbox under a combobox field: one-line rows with favicon, title, muted address, bold matches and a bookmark star.",
  whenToUse: ["Address suggestions under AddressField (history and bookmarks)", "Any field that suggests pages or sites as you type"],
  whenNotToUse: [
    { when: "Choosing one value from a fixed set", use: "Select" },
    { when: "A searchable picker with filters and groups", use: "FilteredSelectPopover" },
    { when: "Navigation rows in a sidebar", use: "NavRow" },
  ],
  recipes: [{ name: "Address suggestions", description: "Rows match the field width; the highlight moves with the arrow keys while focus stays in the field.", render: () => <AddressSuggestions /> }],
  doDont: [
    {
      do: { caption: "One line per page: title first, the address muted, typed terms bold.", render: () => <AddressSuggestions /> },
      dont: { caption: "Two loose lines per row with no icon make pages hard to tell apart.", render: () => <NavRow label="Release notes" meta="https://docs.example.com/changelog" onClick={() => undefined} /> },
    },
  ],
  content: [
    "Pass the page title as is; an empty title shows the address alone.",
    "The address drops the scheme and trailing slash (docs.example.com/changelog), like AddressField.",
    "bookmarkLabel names the star: Bookmarked / 북마크됨.",
  ],
  accessibility: [
    "The list is a listbox and each row an option with aria-selected; give the field listbox={{ id, expanded, activeOptionId }} so it is a combobox that points at the highlighted row.",
    "Focus never leaves the field: rows prevent pointer-down focus, arrows move the highlight, Enter chooses and the first Escape closes the list.",
    "Matched terms are mark elements; the star is an image with its label.",
  ],
  tokens: ["--control-height-lg", "--selection", "--selection-strong", "--radius-control", "--text-tertiary", "--accent-text", "--font-weight-semibold"],
};
