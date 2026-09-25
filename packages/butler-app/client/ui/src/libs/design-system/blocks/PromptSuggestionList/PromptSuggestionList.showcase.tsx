import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Sparkles } from "../../components/Icons";
import { ConversationShell } from "../ConversationShell";
import { PromptSuggestionList } from "./PromptSuggestionList";
import type { FluidPalette, FluidRgb } from "./promptFluid";
import styles from "./PromptSuggestionList.showcase.module.css";

export const meta: ShowcaseMeta = {
  title: "PromptSuggestionList",
  category: "Composer",
  tags: ["empty", "prompt", "suggestion", "new chat"],
  status: "stable",
};

function silkPalette(color: FluidRgb): FluidPalette {
  return [color, color, color, color, color, color];
}

const fluidPaletteOptions = [
  { id: "monochrome", label: "Monochrome", colors: silkPalette([179, 179, 179]) },
  { id: "aurora", label: "Aurora", colors: silkPalette([139, 92, 246]) },
  { id: "bloom", label: "Bloom", colors: silkPalette([217, 70, 239]) },
  { id: "lavender", label: "Lavender", colors: silkPalette([167, 139, 250]) },
  { id: "morning", label: "Morning", colors: silkPalette([125, 211, 252]) },
] as const;

const copy = {
  "en-US": {
    title: "What should we open today?",
    description: "Gather scattered context in one place and pick the next thing you can move on now.",
    moment: "2:10 PM",
    suggestions: [
      ["review", "Look at the risky parts first", "Find missed checks and places to revisit in recent changes.", "Skim the risks and missing checks in the recent changes"],
      ["plan", "Set today's order", "Lay the open work out again in an order you can act on.", "Put today's work in the order I should do it"],
      ["projects", "Mark where things are stuck", "Quietly separate the places in a project where context broke off.", "Find where the project is stuck"],
      ["briefing", "Bring back parked ideas", "Fold ideas and notes so they can become the next action.", "Turn my parked ideas into task cards"],
    ],
  },
  "ko-KR": {
    title: "오늘의 일을 같이 펼쳐볼까요",
    description: "흩어진 맥락을 한곳에 모으고, 지금 붙잡을 수 있는 다음 일을 골라보세요.",
    moment: "오후 2:10",
    suggestions: [
      ["review", "위험한 부분 먼저 보기", "최근 변경사항에서 놓친 검증과 되돌아볼 지점을 찾습니다.", "최근 변경사항의 위험과 빠진 검증을 훑어줘"],
      ["plan", "오늘의 순서 세우기", "열린 일들을 실행 가능한 순서로 다시 얇게 펼칩니다.", "오늘 이어갈 일을 실행 순서로 정리해줘"],
      ["projects", "막힌 곳에 표시하기", "프로젝트 안에서 맥락이 끊긴 부분을 조용히 가릅니다.", "프로젝트 안에서 막힌 지점을 찾아줘"],
      ["briefing", "남겨둔 생각 꺼내기", "아이디어와 메모를 다음 행동으로 옮길 수 있게 접습니다.", "남겨둔 아이디어를 작업 카드로 바꿔줘"],
    ],
  },
} as const;

function Suggestions({ locale, fluid }: ShowcaseRenderContext & { fluid: boolean }) {
  const text = copy[locale];
  return (
    <div className={styles.showcaseStage}>
      <ConversationShell composerReserve={160}>
        <PromptSuggestionList
          title={text.title}
          description={text.description}
          fluidBackground={fluid}
          fluidPaletteOptions={fluid ? fluidPaletteOptions : undefined}
          fluidVariant="silk"
          moment={text.moment}
          titleIcon={<Sparkles />}
          suggestions={text.suggestions.map(([id, title, description, prompt]) => ({ id, title, description, text: prompt }))}
        />
      </ConversationShell>
    </div>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "New chat", widths: ["app", "wide", "375"], render: (context) => <Suggestions {...context} fluid /> },
  { name: "Plain background", render: (context) => <Suggestions {...context} fluid={false} /> },
];
