import { PromptSuggestionList } from "./PromptSuggestionList";
import { Sparkles } from "../../components/Icons";
import type { FluidPalette, FluidRgb } from "./promptFluid";

function silkPalette(color: FluidRgb): FluidPalette {
  return [color, color, color, color, color, color];
}

const fluidPaletteOptions = [
  {
    id: "monochrome",
    label: "Monochrome",
    colors: silkPalette([179, 179, 179]),
  },
  { id: "aurora", label: "Aurora", colors: silkPalette([139, 92, 246]) },
  { id: "bloom", label: "Bloom", colors: silkPalette([217, 70, 239]) },
  {
    id: "lavender",
    label: "Lavender",
    colors: silkPalette([167, 139, 250]),
  },
  { id: "morning", label: "Morning", colors: silkPalette([125, 211, 252]) },
] as const;

export function PromptSuggestionListFixture() {
  return (
    <PromptSuggestionList
      title="오늘의 일을 같이 펼쳐볼까요"
      description="흩어진 맥락을 한곳에 모으고, 지금 붙잡을 수 있는 다음 일을 골라보세요."
      fluidBackground
      fluidPaletteOptions={fluidPaletteOptions}
      fluidVariant="silk"
      moment="오후 2:10"
      titleIcon={<Sparkles />}
      suggestions={[
        {
          id: "review",
          title: "위험한 부분 먼저 보기",
          description:
            "최근 변경사항에서 놓친 검증과 되돌아볼 지점을 찾습니다.",
          text: "최근 변경사항의 위험과 빠진 검증을 훑어줘",
        },
        {
          id: "plan",
          title: "오늘의 순서 세우기",
          description: "열린 일들을 실행 가능한 순서로 다시 얇게 펼칩니다.",
          text: "오늘 이어갈 일을 실행 순서로 정리해줘",
        },
        {
          id: "projects",
          title: "막힌 곳에 표시하기",
          description: "프로젝트 안에서 맥락이 끊긴 부분을 조용히 가릅니다.",
          text: "프로젝트 안에서 막힌 지점을 찾아줘",
        },
        {
          id: "briefing",
          title: "남겨둔 생각 꺼내기",
          description: "아이디어와 메모를 다음 행동으로 옮길 수 있게 접습니다.",
          text: "남겨둔 아이디어를 작업 카드로 바꿔줘",
        },
      ]}
    />
  );
}
