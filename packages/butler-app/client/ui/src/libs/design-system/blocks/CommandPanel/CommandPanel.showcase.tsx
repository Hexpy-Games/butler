import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { Briefcase, Notebook, Settings } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { useHotkey } from "../../lib/useHotkey";
import { CommandPalettePanel } from "./CommandPanel";

export const meta: ShowcaseMeta = {
  title: "CommandPanel",
  category: "Navigation",
  tags: ["command", "palette", "search", "shortcut", "cmd+k"],
  status: "stable",
};

const copy = {
  "en-US": {
    label: "Command palette", placeholder: "Search conversations, projects and settings", close: "Close",
    open: "Open palette", hint: "Cmd+K (Ctrl+K) opens and closes it; Escape closes. Typing Korean (IME) never triggers it.",
    results: ["Desktop client polish", "Weekly review", "Appearance settings"], chosen: "Chose",
  },
  "ko-KR": {
    label: "명령 팔레트", placeholder: "대화, 프로젝트, 설정 검색", close: "닫기",
    open: "팔레트 열기", hint: "Cmd+K(Ctrl+K)로 열고 닫고, Esc로 닫습니다. 한글 입력(IME) 중에는 열리지 않습니다.",
    results: ["데스크톱 앱 다듬기", "주간 회고", "화면 설정"], chosen: "선택:",
  },
} as const;

const ICONS = [<Briefcase key="p" size="md" />, <Notebook key="s" size="md" />, <Settings key="t" size="md" />];

/** Cmd+K toggles the palette; it scales 0.98 -> 1 with a backdrop fade and leaves faster. */
function Palette({ locale }: ShowcaseRenderContext) {
  const text = copy[locale];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState("—");
  // High priority: inside the DS Viewer, whose own Cmd+K focuses its search.
  useHotkey("mod+k", () => setOpen((value) => !value), { priority: "high" });
  const items = text.results
    .map((title, index) => ({ id: String(index), title, icon: ICONS[index], onSelect: () => { setChosen(title); setOpen(false); } }))
    .filter((item) => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return (
    <Stack gap="sm">
      <Typo.Caption tone="secondary">{text.hint}</Typo.Caption>
      <Button variant="outline" data-ds-motion="palette" text={text.open} onClick={() => setOpen(true)} />
      <Typo.Caption>{`${text.chosen} ${chosen}`}</Typo.Caption>
      <CommandPalettePanel open={open} label={text.label} placeholder={text.placeholder} closeLabel={text.close}
        query={query} onQueryChange={setQuery} items={items} onClose={() => setOpen(false)} />
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Palette (Cmd+K open and close)", states: ["open", "closing"], render: (context) => <Palette {...context} /> },
];
