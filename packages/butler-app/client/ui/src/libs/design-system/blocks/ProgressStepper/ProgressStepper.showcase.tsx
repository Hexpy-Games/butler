import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Stack } from "../../components/Stack";
import { ProgressStepper } from "./ProgressStepper";

export const meta: ShowcaseMeta = {
  title: "ProgressStepper",
  category: "Inspector",
  tags: ["stepper", "wizard", "first-run", "progress"],
  status: "beta",
};

const labels = {
  "en-US": { steps: ["Language", "Safety", "Install", "Model"], label: "Setup steps", back: "Back", next: "Next" },
  "ko-KR": { steps: ["언어", "안전", "설치", "모델"], label: "설정 단계", back: "이전", next: "다음" },
} as const;

function Wizard({ context }: { context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  const [index, setIndex] = useState(1);
  return (
    <Stack gap="md">
      <ProgressStepper ariaLabel={copy.label} activeIndex={index} steps={copy.steps.map((label, id) => ({ id: `step-${id}`, label }))} />
      <ButtonContainer size="sm">
        <Button size="sm" variant="outline" disabled={index === 0} onClick={() => setIndex(index - 1)} text={copy.back} />
        <Button size="sm" disabled={index === copy.steps.length - 1} onClick={() => setIndex(index + 1)} text={copy.next} />
      </ButtonContainer>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "First-run steps", widths: ["320", "375", "app"], render: (context) => <Wizard context={context} /> },
];
