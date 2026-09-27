import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/Select";
import { FilteredSelectPopover } from "./FilteredSelectPopover";

const ZONES = ["Asia/Seoul", "America/Los_Angeles", "Europe/Berlin", "UTC"];

// #region recipe: Searchable time zone list
function TimeZones() {
  const [query, setQuery] = useState("");
  const [zone, setZone] = useState("Asia/Seoul");
  return (
    <FilteredSelectPopover title="Time zone" searchLabel="Time zone" searchPlaceholder="Search time zones" searchClearLabel="Clear search"
      searchValue={query} onSearchChange={setQuery} filters={[{ id: "all", label: "All" }]} activeFilterId="all" onFilterChange={() => undefined}
      emptyLabel="No time zones found" width="fixed" resultsMaxRows={6.5}
      groups={[{ id: "zones", title: "All", items: ZONES.filter((id) => id.toLowerCase().includes(query.toLowerCase()))
        .map((id) => ({ id, label: id, selected: id === zone, onSelect: () => setZone(id) })) }]} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A search-first chooser with filters, grouped results and an optional footer choice (inside a Popover).",
  whenToUse: ["Pick a model from many providers", "Any select whose list needs search"],
  whenNotToUse: [
    { when: "Under ten plain options", use: "Select" },
    { when: "A global command search", use: "CommandPalettePanel" },
  ],
  recipes: [{ name: "Searchable time zone list", description: "Search filters the groups; the selected row scrolls into view.", render: () => <TimeZones /> }],
  doDont: [
    {
      do: { caption: "Search first for long lists.", render: () => <TimeZones /> },
      dont: {
        caption: "A plain Select with dozens of options forces scrolling.",
        render: () => (
          <Select defaultValue="UTC"><SelectTrigger aria-label="Time zone"><SelectValue /></SelectTrigger>
            <SelectContent>{ZONES.map((id) => <SelectItem key={id} value={id}>{id}</SelectItem>)}</SelectContent></Select>
        ),
      },
    },
  ],
  content: ["Placeholder names what is searched; the empty label suggests trying fewer words."],
  accessibility: ["The search input is labelled; results are buttons with selected state; Escape clears then closes."],
  tokens: ["--menu-item-height", "--radius-popover", "--scroll-fade-size"],
};
