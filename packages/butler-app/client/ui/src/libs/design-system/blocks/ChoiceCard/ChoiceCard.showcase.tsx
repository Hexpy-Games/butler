import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Monitor, RefreshCcw, Server } from "../../components/Icons";
import { ProviderLogo } from "../../components/ProviderLogo";
import { Tag } from "../../components/Tag";
import { ChoiceCard, ChoiceCardList, ChoiceTile, ChoiceTileGrid, type ChoiceCardState } from "./ChoiceCard";

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
  },
  "ko-KR": {
    signIn: "ChatGPT 계정으로 로그인", noKey: "키 필요 없음", claude: "Anthropic API 키로 연결", gemini: "Google AI Studio 키로 연결",
    computer: "이 컴퓨터", models: "모델 2개 · Ollama", free: "무료 · 비공개", off: "Ollama·LM Studio 꺼짐",
    zai: "Z.AI 코딩 플랜", zaiKey: "코딩 플랜 키", other: "기타 (OpenAI 호환)", own: "직접 서버 입력",
    grok: "xAI API 키", kimi: "Moonshot API 키", connecting: "연결 중…", failed: "키를 확인하지 못했습니다",
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
];

const STATE_OF: Record<string, ChoiceCardState> = { loading: "loading", disabled: "disabled", invalid: "error" };

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "selected", "loading", "invalid", "disabled"],
  variants: ["card", "tile"],
  render: (context) => {
    const state = STATE_OF[context.state] ?? "default";
    const copy = text(context);
    const description = state === "loading" ? copy.connecting : state === "error" ? copy.failed : copy.claude;
    return context.variant === "tile"
      ? <ChoiceTile icon={<ProviderLogo name="claude" />} title="Claude" description={description} state={state} selected={context.state === "selected"} />
      : <ChoiceCard icon={<ProviderLogo name="claude" size="lg" />} title="Claude" description={description} state={state} selected={context.state === "selected"} />;
  },
};
