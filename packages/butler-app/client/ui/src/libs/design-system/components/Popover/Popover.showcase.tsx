import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { FilteredSelectPopover } from "../../blocks/FilteredSelectPopover";
import { ComposerControl } from "../../blocks/ComposerControl";
import { SelectButton } from "../Select";
import { ShieldCheck } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Popover, PopoverAnchor, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "./Popover";

export const meta: ShowcaseMeta = {
  title: "Popover",
  category: "Overlay",
  tags: ["overlay", "contextual", "glass", "composer", "motion"],
  status: "stable",
};

const labels = {
  "en-US": {
    access: "Ask", accessTitle: "Access", accessBody: "Butler asks before editing files or running commands.",
    model: "Model", search: "Search models", clear: "Clear search", empty: "No models match.",
    models: [["gpt-5.1", "GPT-5.1"], ["claude-opus", "Claude Opus"], ["qwen-coder", "Qwen2.5 Coder 14B"]],
    anchor: "The popover anchors to this line, not to the button.", open: "Open",
    context: "Context", narrow: "Narrow readout: min(280px, 100vw - 32px).",
  },
  "ko-KR": {
    access: "질문", accessTitle: "권한", accessBody: "Butler가 파일을 고치거나 명령을 실행하기 전에 묻습니다.",
    model: "모델", search: "모델 검색", clear: "검색 지우기", empty: "일치하는 모델이 없습니다.",
    models: [["gpt-5.1", "GPT-5.1"], ["claude-opus", "Claude Opus"], ["qwen-coder", "Qwen2.5 Coder 14B"]],
    anchor: "팝오버는 버튼이 아니라 이 줄에 붙습니다.", open: "열기",
    context: "컨텍스트", narrow: "좁은 요약: min(280px, 100vw - 32px).",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** AccessModeMenu: a composer pill opens a compact popover above it. */
function AccessPopover({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <ComposerControl icon={<ShieldCheck size="sm" />} label={copy.access} />
      </PopoverTrigger>
      <PopoverContent align="start" data-menu-size="compact" side="top" sideOffset={10}>
        <PopoverHeader>
          <PopoverTitle>{copy.accessTitle}</PopoverTitle>
          <PopoverDescription>{copy.accessBody}</PopoverDescription>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
  );
}

/** SettingsSearchableSelect: SelectButton + FilteredSelectPopover. */
function SearchableSelect({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("gpt-5.1");
  const [query, setQuery] = useState("");
  const items = copy.models
    .filter(([, label]) => label.toLowerCase().includes(query.toLowerCase()))
    .map(([id, label]) => ({ id, label, selected: id === value, onSelect: () => { setValue(id); setOpen(false); } }));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <SelectButton aria-label={copy.model}>{copy.models.find(([id]) => id === value)?.[1]}</SelectButton>
      </PopoverTrigger>
      <PopoverContent align="end" data-menu-size="fit" sideOffset={6}>
        <FilteredSelectPopover
          activeFilterId="all"
          emptyLabel={copy.empty}
          filters={[{ id: "all", label: copy.model }]}
          groups={[{ id: "models", title: copy.model, items }]}
          onFilterChange={() => undefined}
          onSearchChange={setQuery}
          resultsMaxRows={6.5}
          searchClearLabel={copy.clear}
          searchLabel={copy.search}
          searchPlaceholder={copy.search}
          searchValue={query}
          title={copy.model}
          width="fixed"
        />
      </PopoverContent>
    </Popover>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Composer access menu", states: ["open"], render: (context) => <AccessPopover context={context} /> },
  { name: "Searchable select", states: ["open"], render: (context) => <SearchableSelect context={context} /> },
  {
    name: "Custom anchor",
    render: (context) => (
      <Popover>
        <Stack gap="sm">
          <PopoverAnchor asChild><Typo.Caption tone="secondary">{text(context).anchor}</Typo.Caption></PopoverAnchor>
          <PopoverTrigger asChild><SelectButton>{text(context).open}</SelectButton></PopoverTrigger>
        </Stack>
        <PopoverContent align="start"><Typo.Body>{text(context).accessBody}</Typo.Body></PopoverContent>
      </Popover>
    ),
  },
  {
    name: "Narrow width",
    states: ["open"],
    render: (context) => (
      <Popover>
        <PopoverTrigger asChild><SelectButton>{text(context).context}</SelectButton></PopoverTrigger>
        <PopoverContent side="top" width="narrow"><Typo.Caption tone="secondary">{text(context).narrow}</Typo.Caption></PopoverContent>
      </Popover>
    ),
  },
];
