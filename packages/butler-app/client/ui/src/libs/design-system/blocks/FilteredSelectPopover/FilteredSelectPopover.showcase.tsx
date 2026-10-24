import { useState, type ReactElement } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/DropdownMenu";
import { Bot, Pencil, Sparkles } from "../../components/Icons";
import { IconButton } from "../../components/IconButton";
import { Tag, type TagLabelTone } from "../../components/Tag";
import { FilteredSelectPopover } from "./FilteredSelectPopover";

export const meta: ShowcaseMeta = {
  title: "FilteredSelectPopover",
  category: "Navigation",
  tags: ["select", "search", "filter", "model", "popover"],
  status: "stable",
};

const labels = {
  "en-US": {
    model: "Model", search: "Search models", placeholder: "Search models…", clear: "Clear search", empty: "No models found",
    all: "All", local: "Local", reasoning: "Reasoning", levels: ["Instant", "Low", "Medium", "High"], context: (size: string) => `${size} API context`,
    timezone: "Time zone", zones: ["Asia/Seoul", "America/Los_Angeles", "Europe/Berlin", "UTC"],
    tags: "Tags", tagSearch: "Search tags", tagPlaceholder: "Search tags…", noTags: "No tags",
    tagNames: ["bug", "design", "research"], tagMenu: (name: string) => `${name} tag menu`, rename: "Rename", recolor: "Change color", remove: "Delete",
  },
  "ko-KR": {
    model: "모델", search: "모델 검색", placeholder: "모델 검색…", clear: "검색 지우기", empty: "모델이 없습니다",
    all: "전체", local: "로컬", reasoning: "추론", levels: ["즉시", "낮음", "보통", "높음"], context: (size: string) => `API 컨텍스트 ${size}`,
    timezone: "시간대", zones: ["Asia/Seoul", "America/Los_Angeles", "Europe/Berlin", "UTC"],
    tags: "태그", tagSearch: "태그 검색", tagPlaceholder: "태그 검색…", noTags: "태그가 없습니다",
    tagNames: ["버그", "디자인", "조사"], tagMenu: (name: string) => `${name} 태그 메뉴`, rename: "이름 바꾸기", recolor: "색 바꾸기", remove: "삭제",
  },
} as const;

/** ModelMenu: provider filters, grouped results and a reasoning footer. */
function ModelPicker({ context }: { context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [model, setModel] = useState("gpt-51");
  const [reasoning, setReasoning] = useState(2);
  const openai = [["gpt-51", "GPT-5.1", "1.05M"], ["gpt-5-mini", "GPT-5 mini", "400K"]] as const;
  const local = [["qwen-coder", "Qwen2.5 Coder 14B", "32K"]] as const;
  const toItems = (rows: ReadonlyArray<readonly [string, string, string]>, icon: ReactElement) => rows
    .filter(([, label]) => label.toLowerCase().includes(query.toLowerCase()))
    .map(([id, label, size]) => ({ id, label, icon, description: copy.context(size), selected: model === id, onSelect: () => setModel(id) }));
  const groups = [
    { id: "openai", title: "OpenAI", items: filter === "local" ? [] : toItems(openai, <Bot size="md" />) },
    { id: "local", title: copy.local, items: filter === "openai" ? [] : toItems(local, <Sparkles size="md" />) },
  ].filter((group) => group.items.length > 0);
  return (
    <FilteredSelectPopover
      activeFilterId={filter} emptyLabel={copy.empty} groups={groups} onFilterChange={setFilter} onSearchChange={setQuery}
      filters={[{ id: "all", label: copy.all }, { id: "openai", label: "OpenAI" }, { id: "local", label: copy.local }]}
      searchClearLabel={copy.clear} searchLabel={copy.search} searchPlaceholder={copy.placeholder} searchValue={query} title={copy.model}
      footerTitle={copy.reasoning}
      footerOptions={copy.levels.map((label, index) => ({ id: `level-${index}`, label, selected: reasoning === index, onSelect: () => setReasoning(index) }))}
    />
  );
}

/** SettingsSearchableSelect: one filter, fixed width, 6.5 visible rows. */
function TimeZonePicker({ context }: { context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  const [query, setQuery] = useState("");
  const [zone, setZone] = useState("Asia/Seoul");
  return (
    <FilteredSelectPopover
      activeFilterId="all" emptyLabel={copy.empty} filters={[{ id: "all", label: copy.all }]} onFilterChange={() => undefined}
      groups={[{ id: "zones", title: copy.all, items: copy.zones.filter((id) => id.toLowerCase().includes(query.toLowerCase()))
        .map((id) => ({ id, label: id, selected: id === zone, onSelect: () => setZone(id) })) }]}
      onSearchChange={setQuery} resultsMaxRows={6.5} searchClearLabel={copy.clear} searchLabel={copy.timezone}
      searchPlaceholder={copy.timezone} searchValue={query} title={copy.timezone} width="fixed"
    />
  );
}

/** CanonTagChooser: each row carries its own edit menu beside the select button. */
function TagPicker({ context }: { context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string[]>([copy.tagNames[1]]);
  const tones: TagLabelTone[] = ["red", "teal", "purple"];
  const items = copy.tagNames.map((name, index) => ({ name, tone: tones[index]! }))
    .filter(({ name }) => name.toLowerCase().includes(query.toLowerCase()))
    .map(({ name, tone }) => ({
      id: name, label: <Tag tone={tone}>{name}</Tag>, selected: chosen.includes(name),
      onSelect: () => setChosen((value) => value.includes(name) ? value.filter((item) => item !== name) : [...value, name]),
      actions: (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><IconButton label={copy.tagMenu(name)}><Pencil size="sm" /></IconButton></DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={8}>
            <DropdownMenuItem>{copy.rename}</DropdownMenuItem>
            <DropdownMenuItem>{copy.recolor}</DropdownMenuItem>
            <DropdownMenuItem variant="destructive">{copy.remove}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    }));
  return (
    <FilteredSelectPopover
      activeFilterId="all" emptyLabel={copy.noTags} filters={[]} onFilterChange={() => undefined}
      groups={[{ id: "tags", title: copy.tags, items }]} onSearchChange={setQuery} searchClearLabel={copy.clear}
      searchLabel={copy.tagSearch} searchPlaceholder={copy.tagPlaceholder} searchValue={query} title={copy.tags}
    />
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Model picker", states: ["selected"], render: (context) => <ModelPicker context={context} /> },
  { name: "Searchable select (fixed width)", render: (context) => <TimeZonePicker context={context} /> },
  { name: "Rows with actions", states: ["hover", "focus-visible"], render: (context) => <TagPicker context={context} /> },
];
