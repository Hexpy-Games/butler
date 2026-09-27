import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../Button";
import { ButtonContainer } from "../ButtonContainer";
import { ICON_SIZE } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { LoadingIndicator, type LoadingIndicatorState } from "./LoadingIndicator";

export const meta: ShowcaseMeta = {
  title: "LoadingIndicator",
  category: "Feedback",
  tags: ["loading", "spinner", "done", "check", "complete", "motion"],
  status: "beta",
};

const labels = {
  "en-US": { running: "Running", complete: "Complete", finish: "Finish", restart: "Run again", review: "Review the token pages", history: "Checked the build (already done)" },
  "ko-KR": { running: "진행 중", complete: "완료", finish: "완료하기", restart: "다시 실행", review: "토큰 페이지 검토", history: "빌드 확인 (이미 완료)" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

function SpinnerToCheck({ context }: { context: ShowcaseRenderContext }) {
  const [state, setState] = useState<LoadingIndicatorState>("loading");
  const [run, setRun] = useState(0);
  const copy = text(context);
  return (
    <Stack gap="md">
      <Stack gap="sm" key={run}>
        {(["md", "lg"] as const).map((size) => (
          <Stack align="row" gap="sm" cross="center" key={size}>
            <LoadingIndicator state={state} size={ICON_SIZE[size]} />
            <Typo.Body>{`${copy.review} · ${state === "loading" ? copy.running : copy.complete}`}</Typo.Body>
          </Stack>
        ))}
      </Stack>
      <ButtonContainer size="sm">
        <Button size="sm" variant="outline" data-ds-motion="loading-done" disabled={state === "done"} text={copy.finish} onClick={() => setState("done")} />
        <Button size="sm" variant="borderless" text={copy.restart} onClick={() => { setState("loading"); setRun(run + 1); }} />
      </ButtonContainer>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Spinner to check", states: ["loading", "done"], render: (context) => <SpinnerToCheck context={context} /> },
  {
    name: "Mounted done (static)",
    render: (context) => (
      <Stack align="row" gap="sm" cross="center">
        <LoadingIndicator state="done" size={ICON_SIZE.lg} />
        <Typo.Body>{text(context).history}</Typo.Body>
      </Stack>
    ),
  },
];
