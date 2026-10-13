import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Bookmark, FileText, History, Key, Monitor, RefreshCcw, Server } from "../../components/Icons";
import { ProviderLogo } from "../../components/ProviderLogo";
import { Tag } from "../../components/Tag";
import { ChoiceCard, ChoiceCardList, ChoiceTile, ChoiceTileGrid, type ChoiceCardState } from "./ChoiceCard";
import { ChoiceCheckCard } from "./ChoiceCheckCard";

export const meta: ShowcaseMeta = {
  title: "ChoiceCard",
  category: "Settings & Forms",
  tags: ["choice", "card", "tile", "provider", "first-run", "picker", "grid"],
  status: "stable",
};

const labels = {
  "en-US": {
    signIn: "Sign in with ChatGPT", noKey: "No key needed", claude: "Use an Anthropic API key", gemini: "Use a Google AI Studio key",
    computer: "This computer", models: "2 models · Ollama", free: "Free · Private", off: "Ollama or LM Studio off",
    zai: "Z.AI Coding Plan", zaiKey: "Coding Plan key", other: "Other (OpenAI-compatible)", own: "Your own server",
    grok: "xAI API key", kimi: "Moonshot API key", connecting: "Connecting…", failed: "Key didn't work",
    include: "Include", bookmarks: "Bookmarks", passwords: "Passwords", history: "History", keychain: "Needs Keychain access",
    instructions: "Instructions", server: "MCP server", needsKey: "MCP server · Needs a key", empty: "Empty file",
  },
  "ko-KR": {
    signIn: "ChatGPT 계정으로 로그인", noKey: "키 필요 없음", claude: "Anthropic API 키로 연결", gemini: "Google AI Studio 키로 연결",
    computer: "이 컴퓨터", models: "모델 2개 · Ollama", free: "무료 · 비공개", off: "Ollama·LM Studio 꺼짐",
    zai: "Z.AI 코딩 플랜", zaiKey: "코딩 플랜 키", other: "기타 (OpenAI 호환)", own: "직접 서버 입력",
    grok: "xAI API 키", kimi: "Moonshot API 키", connecting: "연결 중…", failed: "키를 확인하지 못했습니다",
    include: "가져올 항목", bookmarks: "북마크", passwords: "비밀번호", history: "방문 기록", keychain: "키체인 접근 필요",
    instructions: "지침", server: "MCP 서버", needsKey: "MCP 서버 · 키 입력 필요", empty: "비어 있는 파일",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

function ModelPicker() {
  const [selected, setSelected] = useState("qwen3:8b");
  return (
    <ChoiceCardList role="radiogroup">
      {[["qwen3:8b", "5.2 GB"], ["gemma3:12b", "8.1 GB"]].map(([id, size]) => (
        <ChoiceCard aria-checked={selected === id} chevron={false} icon={<ProviderLogo name="ollama" />} key={id}
          meta={size} role="radio" selected={selected === id} title={id!} onClick={() => setSelected(id!)} />
      ))}
    </ChoiceCardList>
  );
}

function CheckList({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  const [on, setOn] = useState<Record<string, boolean>>({ bookmarks: true, passwords: false, history: true });
  const items = [["bookmarks", copy.bookmarks, <Bookmark size="md" key="b" />], ["passwords", copy.passwords, <Key size="md" key="k" />],
    ["history", copy.history, <History size="md" key="h" />]] as const;
  return (
    <ChoiceCardList role="group" aria-label={copy.include}>
      {items.map(([id, title, icon]) => (
        <ChoiceCheckCard key={id} icon={icon} title={title} checked={on[id]!} onCheckedChange={(checked) => setOn((prior) => ({ ...prior, [id]: checked }))} />
      ))}
    </ChoiceCardList>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Top choices",
    widths: ["375", "app"],
    render: (context) => (
      <ChoiceCardList>
        <ChoiceCard icon={<ProviderLogo name="openai" size="lg" />} title="ChatGPT" tag={<Tag tone="accent">{text(context).noKey}</Tag>} description={text(context).signIn} />
        <ChoiceCard icon={<ProviderLogo name="claude" size="lg" />} title="Claude" description={text(context).claude} />
        <ChoiceCard icon={<ProviderLogo name="gemini" size="lg" />} title="Gemini" description={text(context).gemini} />
        <ChoiceCard icon={<Monitor size="lg" />} title={text(context).computer} tag={<Tag tone="success">{text(context).free}</Tag>} description={text(context).models} />
      </ChoiceCardList>
    ),
  },
  {
    name: "More choices grid (equal-size tiles, long names wrap to two lines)",
    widths: ["320", "375", "app"],
    render: (context) => (
      <ChoiceTileGrid>
        <ChoiceTile icon={<Monitor size="md" />} title={text(context).computer} description={text(context).off} placeholder cornerIcon={<RefreshCcw size="xs" />} />
        <ChoiceTile icon={<ProviderLogo name="grok" />} title="Grok" description={text(context).grok} />
        <ChoiceTile icon={<ProviderLogo name="kimi" />} title="Kimi" description={text(context).kimi} state="loading" />
        <ChoiceTile icon={<ProviderLogo name="zai" />} title={text(context).zai} description={text(context).zaiKey} />
        <ChoiceTile icon={<Server size="md" />} title={text(context).other} description={text(context).own} />
      </ChoiceTileGrid>
    ),
  },
  { name: "Radio rows (local models)", render: () => <ModelPicker /> },
  { name: "Check cards (multi-select)", widths: ["375", "app"], render: (context) => <CheckList context={context} /> },
  {
    name: "Check cards with descriptions and a blocked item",
    widths: ["375", "app"],
    render: (context) => (
      <ChoiceCardList role="group" aria-label="Codex">
        <ChoiceCheckCard icon={<FileText size="md" />} title={text(context).instructions} description={`~/.codex/AGENTS.md · ${text(context).empty}`}
          checked={false} disabledReason={text(context).empty} onCheckedChange={() => undefined} />
        <ChoiceCheckCard icon={<Server size="md" />} title="linear" description={text(context).server} checked onCheckedChange={() => undefined} />
        <ChoiceCheckCard icon={<Server size="md" />} title="sentry" description={text(context).needsKey} checked={false} onCheckedChange={() => undefined} />
      </ChoiceCardList>
    ),
  },
];

const STATE_OF: Record<string, ChoiceCardState> = { loading: "loading", disabled: "disabled", invalid: "error" };

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "selected", "loading", "invalid", "disabled"],
  variants: ["card", "tile", "check"],
  render: (context) => {
    const state = STATE_OF[context.state] ?? "default";
    const copy = text(context);
    const description = state === "loading" ? copy.connecting : state === "error" ? copy.failed : copy.claude;
    if (context.variant === "check") {
      return <ChoiceCheckCard icon={<ProviderLogo name="claude" />} title="Claude Code" description={copy.claude} checked={context.state === "selected"}
        disabled={state === "loading"} disabledReason={state === "disabled" ? copy.failed : undefined} onCheckedChange={() => undefined} />;
    }
    return context.variant === "tile"
      ? <ChoiceTile icon={<ProviderLogo name="claude" />} title="Claude" description={description} state={state} selected={context.state === "selected"} />
      : <ChoiceCard icon={<ProviderLogo name="claude" size="lg" />} title="Claude" description={description} state={state} selected={context.state === "selected"} />;
  },
};
