import type { ShowcaseGuidance } from "../../showcase";
import { Briefcase, Notebook } from "../../components/Icons";
import { NavRow } from "../NavRow";
import { ICONS } from "../TabStrip/TabStrip.demo";
import { SuggestionItemRow, SuggestionList, SuggestionRow } from "./SuggestionList";

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

// #region recipe: Mention suggestions
function MentionSuggestions() {
  // In the app: Popover open while the caret is in an "@" word, PopoverAnchor on the "@" (virtualRef),
  // PopoverContent side="top" align="start" density="list" presentation="popover" holding this list.
  return (
    <SuggestionList id="mention-suggestions" label="Reference a chat or project">
      <SuggestionItemRow id="mention-suggestion-0" icon={<Notebook size="md" />} title="Design system cleanup" meta="butler" matchMeta
        query="design" active onSelect={() => undefined} />
      <SuggestionItemRow id="mention-suggestion-1" icon={<Briefcase size="md" />} title="Design research" meta="Project"
        query="design" onSelect={() => undefined} />
    </SuggestionList>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The listbox under a combobox field: one-line rows with favicon, title, muted address, bold matches and a bookmark star; SuggestionItemRow is the same row for app items (type glyph, title, muted meta).",
  whenToUse: [
    "Address suggestions under AddressField (history and bookmarks)",
    "Any field that suggests pages or sites as you type",
    "App items suggested from typed text with no search field, such as the composer @ menu (SuggestionItemRow)",
  ],
  whenNotToUse: [
    { when: "Choosing one value from a fixed set", use: "Select" },
    { when: "A searchable picker with filters and groups", use: "FilteredSelectPopover" },
    { when: "Navigation rows in a sidebar", use: "NavRow" },
  ],
  recipes: [
    { name: "Address suggestions", description: "Rows match the field width; the highlight moves with the arrow keys while focus stays in the field.", render: () => <AddressSuggestions /> },
    { name: "Mention suggestions", description: "SuggestionItemRow: a type glyph, the title and muted meta; the text typed after @ is the query and its matches are bold.", render: () => <MentionSuggestions /> },
  ],
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
    "SuggestionItemRow meta is where the item lives (its project) or its type (Project / 프로젝트); omit it when there is nothing to add.",
    "Set matchMeta only when the meta is a field the query searches (a project name); a type label is never bold.",
    "With no matching item, close the list instead of showing an empty row.",
  ],
  accessibility: [
    "The list is a listbox and each row an option with aria-selected; give the field listbox={{ id, expanded, activeOptionId }} so it is a combobox that points at the highlighted row.",
    "Focus never leaves the field: rows prevent pointer-down focus, arrows move the highlight, Enter chooses and the first Escape closes the list.",
    "Matched terms are mark elements; the star is an image with its label.",
  ],
  tokens: ["--control-height-lg", "--selection", "--selection-strong", "--radius-control", "--text-tertiary", "--accent-text", "--font-weight-semibold"],
};
