import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Bookmark, FileText, History, Key, Server } from "../../components/Icons";
import { ProviderLogo } from "../../components/ProviderLogo";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { CheckCard, CheckCardList } from "./CheckCard";

export const meta: ShowcaseMeta = {
  title: "CheckCard",
  category: "Settings & Forms",
  tags: ["check", "checkbox", "multi-select", "card", "import", "pick several"],
  status: "beta",
};

const labels = {
  "en-US": {
    group: "What to import", bookmarks: "Bookmarks", passwords: "Passwords", history: "History", keychain: "Needs Keychain access",
    instructions: "Instructions", server: "MCP server", needsKey: "MCP server · Needs a key", empty: "Empty file",
    holds: "Instructions · 3 MCP servers", servers: "2 MCP servers",
    motion: "Click, tap or press Space. Check: the ring fills from the centre and the check draws in (220 ms). Uncheck: the check undraws, then the fill clears (170 ms). Press: the pressed fill of a wide row fades in under the content (120 ms); the card never shrinks. Interrupting a toggle reverses it from where it is. Reduced motion: fades only, no scale or stroke draw.",
    mixed: "One-line and two-line cards mixed: the glyph is the title's text size on the title line; the check circle is centered on each card.",
  },
  "ko-KR": {
    group: "가져올 항목", bookmarks: "북마크", passwords: "비밀번호", history: "방문 기록", keychain: "키체인 접근 필요",
    instructions: "지침", server: "MCP 서버", needsKey: "MCP 서버 · 키 입력 필요", empty: "비어 있는 파일",
    holds: "지침 · MCP 서버 3개", servers: "MCP 서버 2개",
    motion: "누르거나 탭하거나 Space를 눌러 보세요. 체크: 원이 가운데서 채워지고 체크가 그려집니다(220ms). 해제: 체크가 지워진 뒤 채움이 빠집니다(170ms). 누를 때: 넓은 행의 눌림 색이 내용 아래에 옅게 깔립니다(120ms). 카드는 줄어들지 않습니다. 도중에 다시 누르면 그 자리에서 되돌아갑니다. 동작 줄이기: 크기 변화와 선 그리기 없이 페이드만 남습니다.",
    mixed: "한 줄과 두 줄 카드를 섞은 목록: 아이콘은 제목 글자 크기로 제목 줄에 맞추고, 체크 원은 카드마다 세로 가운데에 둡니다.",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** A live list of four: checked, unchecked, with a description, and blocked with its reason. */
function ItemList({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  const [on, setOn] = useState<Record<string, boolean>>({ claude: true, codex: false, linear: true });
  const toggle = (id: string) => (checked: boolean) => setOn((prior) => ({ ...prior, [id]: checked }));
  return (
    <CheckCardList label={copy.group}>
      <CheckCard icon={<ProviderLogo name="claude" />} title="Claude Code" description={copy.holds} checked={on.claude!} onCheckedChange={toggle("claude")} />
      <CheckCard icon={<ProviderLogo name="openai" />} title="Codex" description={copy.servers} checked={on.codex!} onCheckedChange={toggle("codex")} />
      <CheckCard icon={<Server size="md" />} title="linear" description={copy.needsKey} checked={on.linear!} onCheckedChange={toggle("linear")} />
      <CheckCard icon={<FileText size="md" />} title={copy.instructions} description={`~/.codex/AGENTS.md · ${copy.empty}`}
        checked={false} disabledReason={copy.empty} onCheckedChange={() => undefined} />
    </CheckCardList>
  );
}

function PlainList({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  const [on, setOn] = useState<Record<string, boolean>>({ bookmarks: true, passwords: false, history: true });
  const items = [["bookmarks", copy.bookmarks, <Bookmark size="md" key="b" />], ["passwords", copy.passwords, <Key size="md" key="k" />],
    ["history", copy.history, <History size="md" key="h" />]] as const;
  return (
    <CheckCardList label={copy.group}>
      {items.map(([id, title, icon]) => (
        <CheckCard key={id} icon={icon} title={title} checked={on[id]!} onCheckedChange={(checked) => setOn((prior) => ({ ...prior, [id]: checked }))} />
      ))}
      <CheckCard title={copy.passwords} description={copy.keychain} checked={false} onCheckedChange={() => undefined} />
    </CheckCardList>
  );
}

/** One-line and two-line cards in one list (instructions alone, servers with a note). */
function MixedList({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  const [on, setOn] = useState<Record<string, boolean>>({ instructions: true, linear: true, files: false, bookmarks: true });
  const toggle = (id: string) => (checked: boolean) => setOn((prior) => ({ ...prior, [id]: checked }));
  return (
    <CheckCardList label={copy.group}>
      <CheckCard icon={<FileText size="md" />} title={copy.instructions} checked={on.instructions!} onCheckedChange={toggle("instructions")} />
      <CheckCard icon={<Server size="md" />} title="linear" description={copy.needsKey} checked={on.linear!} onCheckedChange={toggle("linear")} />
      <CheckCard icon={<Server size="md" />} title="files" checked={on.files!} onCheckedChange={toggle("files")} />
      <CheckCard icon={<Bookmark size="md" />} title={copy.bookmarks} checked={on.bookmarks!} onCheckedChange={toggle("bookmarks")} />
      <CheckCard icon={<Key size="md" />} title={copy.passwords} description={copy.keychain} checked={false} onCheckedChange={() => undefined} />
    </CheckCardList>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Pick several (default)", widths: ["375", "app"], render: (context) => <ItemList context={context} /> },
  {
    name: "Motion: check, uncheck and press (live)",
    widths: ["375", "app"],
    render: (context) => (
      <Stack gap="sm">
        <Typo.Caption tone="secondary">{text(context).motion}</Typo.Caption>
        <PlainList context={context} />
      </Stack>
    ),
  },
  {
    name: "Mixed one-line and two-line cards",
    widths: ["375", "app"],
    render: (context) => (
      <Stack gap="sm">
        <Typo.Caption tone="secondary">{text(context).mixed}</Typo.Caption>
        <MixedList context={context} />
      </Stack>
    ),
  },
  { name: "Items to include (icons, and one without)", widths: ["375", "app"], render: (context) => <PlainList context={context} /> },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "selected", "disabled"],
  variants: ["icon", "plain"],
  render: (context) => {
    const copy = text(context);
    return (
      <CheckCard icon={context.variant === "icon" ? <ProviderLogo name="claude" /> : undefined} title="Claude Code" description={copy.holds}
        checked={context.state === "selected"} disabledReason={context.state === "disabled" ? copy.empty : undefined} onCheckedChange={() => undefined} />
    );
  },
};
