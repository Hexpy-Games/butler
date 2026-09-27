import { useEffect, useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../Button";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { RollingSwap } from "./RollingSwap";

export const meta: ShowcaseMeta = {
  title: "RollingSwap",
  category: "Feedback",
  tags: ["motion", "status", "ticker", "swap"],
  status: "stable",
};

const steps = {
  "en-US": ["Reading the project notes", "Searching for the failing test", "Running the unit tests", "Summarizing what changed"],
  "ko-KR": ["프로젝트 메모를 읽는 중", "실패한 테스트를 찾는 중", "단위 테스트를 실행하는 중", "바뀐 점을 요약하는 중"],
} as const;
const next = { "en-US": "Next step", "ko-KR": "다음 단계" } as const;

function Ticker({ locale, auto }: ShowcaseRenderContext & { auto: boolean }) {
  const [index, setIndex] = useState(0);
  const list = steps[locale];
  useEffect(() => {
    if (!auto) return undefined;
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % list.length), 1600);
    return () => window.clearInterval(timer);
  }, [auto, list.length]);
  return (
    <Stack gap="md">
      <RollingSwap itemKey={String(index)}>
        <Typo.Body as="p">{list[index]}</Typo.Body>
      </RollingSwap>
      {auto ? null : (
        <Button size="sm" variant="outline" text={next[locale]} onClick={() => setIndex((value) => (value + 1) % list.length)} />
      )}
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Live status", states: ["changing"], render: ({ locale }) => <Ticker locale={locale} auto /> },
  { name: "Step by step", states: ["enter", "exit"], render: ({ locale }) => <Ticker locale={locale} auto={false} /> },
];
