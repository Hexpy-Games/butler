import { useState } from "react";
import { Bot, Sparkles } from "../../components/Icons";
import { FilteredSelectPopover } from "./FilteredSelectPopover";

export function FilteredSelectPopoverFixture() {
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [reasoning, setReasoning] = useState("medium");

  return (
    <FilteredSelectPopover
      title="Model"
      searchLabel="Search models"
      searchPlaceholder="Search models..."
      searchClearLabel="Clear search"
      searchValue={query}
      filters={[
        { id: "all", label: "All" },
        { id: "openai", label: "OpenAI" },
        { id: "local", label: "Local" },
      ]}
      activeFilterId={provider}
      onFilterChange={setProvider}
      onSearchChange={setQuery}
      emptyLabel="No models found"
      groups={[
        {
          id: "openai",
          title: "OpenAI",
          items: [
            {
              id: "gpt-55",
              label: "GPT-5.5",
              description: "1.05M API context",
              selected: true,
              icon: <Bot size={15} />,
            },
            {
              id: "gpt-54",
              label: "GPT-5.4",
              description: "1.05M API context",
              icon: <Bot size={15} />,
            },
          ],
        },
        {
          id: "local",
          title: "Local",
          items: [
            {
              id: "gemma",
              label: "Gemma 4 31B it",
              description: "16k API context",
              icon: <Sparkles size={15} />,
            },
          ],
        },
      ]}
      footerTitle="Reasoning"
      footerOptions={[
        { id: "none", label: "Instant", selected: reasoning === "none", onSelect: () => setReasoning("none") },
        { id: "low", label: "Low", selected: reasoning === "low", onSelect: () => setReasoning("low") },
        { id: "medium", label: "Medium", selected: reasoning === "medium", onSelect: () => setReasoning("medium") },
        { id: "high", label: "High", selected: reasoning === "high", onSelect: () => setReasoning("high") },
      ]}
    />
  );
}
