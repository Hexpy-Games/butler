import { useState, type KeyboardEvent } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Popover, PopoverAnchor, PopoverContent } from "../../components/Popover";
import { Stack } from "../../components/Stack";
import { AddressField } from "../AddressField";
import { ICONS } from "../TabStrip/TabStrip.demo";
import { ITEMS, ItemRows, itemIcon } from "./SuggestionItems.demo";
import { SuggestionItemRow, SuggestionList, SuggestionRow, type SuggestionKind } from "./SuggestionList";

export const meta: ShowcaseMeta = {
  title: "SuggestionList",
  category: "Browser",
  tags: ["browser", "address", "suggestions", "autocomplete", "combobox", "listbox", "history", "bookmark", "favicon", "mention", "reference", "composer"],
  status: "beta",
};

interface Item { title: string; url: string; icon?: string; kind?: SuggestionKind }

const COPY: Record<ShowcaseRenderContext["locale"], { list: string; field: string; bookmarked: string; query: string; items: Item[] }> = {
  "en-US": {
    list: "Address suggestions", field: "Address", bookmarked: "Bookmarked", query: "docs",
    items: [
      { title: "Docs - Getting started", url: "https://docs.example.com/guides/getting-started", icon: ICONS.docs, kind: "bookmark" },
      { title: "Release notes", url: "https://docs.example.com/changelog?tab=desktop", icon: ICONS.docs },
      { title: "Shared docs folder", url: "https://drive.example.net/folders/team-docs", icon: ICONS.mail },
      { title: "", url: "https://status.example.org/docs", icon: ICONS.broken },
    ],
  },
  "ko-KR": {
    list: "주소 추천", field: "주소", bookmarked: "북마크됨", query: "문서",
    items: [
      { title: "개발 문서 - 시작하기", url: "https://docs.example.com/guides/getting-started", icon: ICONS.docs, kind: "bookmark" },
      { title: "릴리스 문서", url: "https://docs.example.com/changelog?tab=desktop", icon: ICONS.docs },
      { title: "팀 공유 문서 폴더", url: "https://drive.example.net/folders/team-docs", icon: ICONS.mail },
      { title: "", url: "https://status.example.org/문서", icon: ICONS.broken },
    ],
  },
};

function Rows({ locale, active, query }: ShowcaseRenderContext & { active: number; query: string }) {
  const copy = COPY[locale];
  return (
    <SuggestionList id={`suggestions-${locale}`} label={copy.list}>
      {copy.items.map((item, index) => (
        <SuggestionRow key={item.url} id={`suggestion-${locale}-${index}`} title={item.title} url={item.url} iconSrc={item.icon} kind={item.kind}
          bookmarkLabel={copy.bookmarked} query={query} active={index === active} onSelect={() => undefined} />
      ))}
    </SuggestionList>
  );
}

/** AddressSuggestions in miniature: type, move with the arrows, Enter chooses, the first Escape closes the list. */
function Live({ locale }: ShowcaseRenderContext) {
  const copy = COPY[locale];
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [url, setUrl] = useState("https://docs.example.com/");
  const items = copy.items.filter((item) => query && `${item.title} ${item.url}`.toLowerCase().includes(query.toLowerCase()));
  const open = editing && items.length > 0;
  const listId = `live-suggestions-${locale}`;
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (open && step) {
      event.preventDefault();
      setActive((index) => (index + step < -1 ? items.length - 1 : index + step >= items.length ? -1 : index + step));
    } else if (open && event.key === "Enter" && items[active]) {
      event.preventDefault();
      setUrl(items[active]!.url);
      setEditing(false);
    } else if (open && event.key === "Escape") {
      event.preventDefault();
      setQuery("");
    }
  };
  return (
    <Popover open={open}>
      <PopoverAnchor asChild>
        <Stack grow>
          <AddressField url={url} labels={{ field: copy.field }} editing={editing} onEditingChange={(next) => { setEditing(next); setQuery(""); setActive(-1); }}
            onSubmit={(value) => setUrl(value || url)} onInputChange={(value) => { setQuery(value); setActive(-1); }} onInputKeyDown={keys}
            listbox={{ id: listId, expanded: open, activeOptionId: active >= 0 ? `${listId}-${active}` : undefined }} />
        </Stack>
      </PopoverAnchor>
      <PopoverContent align="start" width="anchor" density="list" onOpenAutoFocus={(event) => event.preventDefault()}>
        <SuggestionList id={listId} label={copy.list}>
          {items.map((item, index) => (
            <SuggestionRow key={item.url} id={`${listId}-${index}`} title={item.title} url={item.url} iconSrc={item.icon} kind={item.kind}
              bookmarkLabel={copy.bookmarked} query={query} active={index === active} onSelect={() => { setUrl(item.url); setEditing(false); }} />
          ))}
        </SuggestionList>
      </PopoverContent>
    </Popover>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Under the address field (type to filter)", states: ["open"], render: (context) => <Live {...context} /> },
  {
    name: "Matches in bold, keyboard highlight, bookmark star",
    widths: ["320", "375", "app"],
    render: (context) => <Rows {...context} active={1} query={COPY[context.locale].query} />,
  },
  { name: "No query (recent pages)", render: (context) => <Rows {...context} active={-1} query="" /> },
  {
    name: "App items: the composer @ menu, matches in bold",
    widths: ["320", "375", "app"],
    render: (context) => <ItemRows {...context} active={0} query={ITEMS[context.locale].query} />,
  },
  { name: "App items: bare @ (recent first)", render: (context) => <ItemRows {...context} active={0} query="" /> },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "selected"],
  variants: ["history", "bookmark", "item"],
  render: ({ locale, state, variant }) => {
    if (variant === "item") {
      const copy = ITEMS[locale];
      const item = copy.items[0]!;
      return (
        <SuggestionList id={`matrix-${locale}-item-${state}`} label={copy.list}>
          <SuggestionItemRow id={`matrix-${locale}-item-${state}-row`} icon={itemIcon(item.kind)} title={item.title} meta={item.meta} matchMeta
            query={copy.query} active={state === "selected"} onSelect={() => undefined} />
        </SuggestionList>
      );
    }
    const copy = COPY[locale];
    const item = copy.items[variant === "bookmark" ? 0 : 1]!;
    return (
      <SuggestionList id={`matrix-${locale}-${variant}-${state}`} label={copy.list}>
        <SuggestionRow id={`matrix-${locale}-${variant}-${state}-row`} title={item.title} url={item.url} iconSrc={item.icon} kind={item.kind}
          bookmarkLabel={copy.bookmarked} query={copy.query} active={state === "selected"} onSelect={() => undefined} />
      </SuggestionList>
    );
  },
};
