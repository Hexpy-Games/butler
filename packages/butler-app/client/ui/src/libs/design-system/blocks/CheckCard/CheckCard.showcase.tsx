import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Bookmark, FileText, History, Key, Server } from "../../components/Icons";
import { ProviderLogo } from "../../components/ProviderLogo";
import { CheckCard, CheckCardList, type CheckCardProps } from "./CheckCard";

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
  },
  "ko-KR": {
    group: "가져올 항목", bookmarks: "북마크", passwords: "비밀번호", history: "방문 기록", keychain: "키체인 접근 필요",
    instructions: "지침", server: "MCP 서버", needsKey: "MCP 서버 · 키 입력 필요", empty: "비어 있는 파일",
    holds: "지침 · MCP 서버 3개", servers: "MCP 서버 2개",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

type Variant = Pick<CheckCardProps, "indicatorSide" | "checkedMark">;

/** A live list of four: checked, unchecked, with a description, and blocked with its reason. */
function ItemList({ context, variant = {} }: { context: ShowcaseRenderContext; variant?: Variant }) {
  const copy = text(context);
  const [on, setOn] = useState<Record<string, boolean>>({ claude: true, codex: false, linear: true });
  const toggle = (id: string) => (checked: boolean) => setOn((prior) => ({ ...prior, [id]: checked }));
  return (
    <CheckCardList label={copy.group}>
      <CheckCard {...variant} icon={<ProviderLogo name="claude" />} title="Claude Code" description={copy.holds} checked={on.claude!} onCheckedChange={toggle("claude")} />
      <CheckCard {...variant} icon={<ProviderLogo name="openai" />} title="Codex" description={copy.servers} checked={on.codex!} onCheckedChange={toggle("codex")} />
      <CheckCard {...variant} icon={<Server size="md" />} title="linear" description={copy.needsKey} checked={on.linear!} onCheckedChange={toggle("linear")} />
      <CheckCard {...variant} icon={<FileText size="md" />} title={copy.instructions} description={`~/.codex/AGENTS.md · ${copy.empty}`}
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

export const stories: ShowcaseStory[] = [
  { name: "Pick several (default)", widths: ["375", "app"], render: (context) => <ItemList context={context} /> },
  { name: "Variant A · indicator at the end, check", widths: ["375", "app"], render: (context) => <ItemList context={context} variant={{ indicatorSide: "end", checkedMark: "check" }} /> },
  { name: "Variant B · indicator at the start, check", widths: ["375", "app"], render: (context) => <ItemList context={context} variant={{ indicatorSide: "start", checkedMark: "check" }} /> },
  { name: "Variant C · indicator at the end, filled", widths: ["375", "app"], render: (context) => <ItemList context={context} variant={{ indicatorSide: "end", checkedMark: "fill" }} /> },
  { name: "Variant D · indicator at the start, filled", widths: ["375", "app"], render: (context) => <ItemList context={context} variant={{ indicatorSide: "start", checkedMark: "fill" }} /> },
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
