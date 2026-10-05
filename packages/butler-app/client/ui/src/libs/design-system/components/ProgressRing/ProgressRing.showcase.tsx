import { useState, type ReactNode } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { NavRow } from "../../blocks/NavRow";
import { Button } from "../Button";
import { ButtonContainer } from "../ButtonContainer";
import { CircleAlert, Settings } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { ProgressRing, type ProgressRingSize, type ProgressRingTone } from "./ProgressRing";

export const meta: ShowcaseMeta = {
  title: "ProgressRing",
  category: "Feedback",
  tags: ["progress", "ring", "donut", "download", "update", "indeterminate", "sidebar"],
  status: "stable",
};

const labels = {
  "en-US": {
    progress: "Progress", downloading: "Downloading update", preparing: "Preparing update", ready: "Update ready",
    failed: "Update failed", restart: "Restart", settings: "Settings", working: "Working", advance: "Advance",
    indeterminate: "Unknown size", reset: "Reset", tones: { default: "Default", success: "Complete", warning: "Low space", danger: "Failed" },
  },
  "ko-KR": {
    progress: "진행률", downloading: "업데이트 받는 중", preparing: "업데이트 준비 중", ready: "업데이트 준비됨",
    failed: "업데이트 실패", restart: "다시 시작", settings: "설정", working: "진행 중", advance: "진행",
    indeterminate: "크기 모름", reset: "처음으로", tones: { default: "기본", success: "완료", warning: "공간 부족", danger: "실패" },
  },
} as const;

const text = ({ locale }: ShowcaseRenderContext) => labels[locale];
const SIZES: ProgressRingSize[] = ["xs", "sm", "md", "lg", "sidebar"];

function Captioned({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <Stack gap="xs" cross="center">
      {children}
      <Typo.Caption>{caption}</Typo.Caption>
    </Stack>
  );
}

/** A row stepping through determinate and indeterminate progress: the box never moves. */
function LiveRing({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  const [value, setValue] = useState(0.3);
  const [indeterminate, setIndeterminate] = useState(false);
  const percent = Math.round(value * 100);
  return (
    <Stack gap="md">
      <Stack align="row" gap="sm" cross="center">
        <ProgressRing size="lg" value={value} indeterminate={indeterminate} tone={value >= 1 ? "success" : "default"}
          aria-label={copy.progress} />
        <Typo.Body>{indeterminate ? copy.preparing : `${copy.downloading} · ${percent}%`}</Typo.Body>
      </Stack>
      <ButtonContainer size="sm">
        <Button size="sm" variant="outline" text={copy.advance} data-ds-motion="progress-ring-advance"
          onClick={() => { setIndeterminate(false); setValue(Math.min(1, value + 0.2)); }} />
        <Button size="sm" variant="outline" text={copy.indeterminate} data-ds-motion="progress-ring-indeterminate"
          onClick={() => setIndeterminate(!indeterminate)} />
        <Button size="sm" variant="borderless" text={copy.reset} onClick={() => { setIndeterminate(false); setValue(0); }} />
      </ButtonContainer>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Values",
    render: (context) => (
      <Stack align="row" gap="xl" wrap>
        {[0, 0.08, 0.25, 0.5, 0.75, 1].map((value) => (
          <Captioned key={value} caption={`${Math.round(value * 100)}%`}>
            <ProgressRing size="lg" value={value} aria-label={`${text(context).progress} ${Math.round(value * 100)}%`} />
          </Captioned>
        ))}
      </Stack>
    ),
  },
  {
    name: "Sizes",
    render: (context) => (
      <Stack gap="lg">
        {[false, true].map((indeterminate) => (
          <Stack key={String(indeterminate)} align="row" gap="xl" cross="end" wrap>
            {SIZES.map((size) => (
              <Captioned key={size} caption={size}>
                <ProgressRing size={size} value={0.62} indeterminate={indeterminate} aria-label={text(context).progress} />
              </Captioned>
            ))}
          </Stack>
        ))}
      </Stack>
    ),
  },
  {
    name: "Indeterminate",
    states: ["loading"],
    render: (context) => (
      <Stack align="row" gap="sm" cross="center">
        <ProgressRing size="md" indeterminate aria-label={text(context).preparing} />
        <Typo.Body>{text(context).preparing}</Typo.Body>
      </Stack>
    ),
  },
  {
    name: "Tones",
    render: (context) => (
      <Stack align="row" gap="xl" wrap>
        {([["default", 0.6], ["success", 1], ["warning", 0.86], ["danger", 0.4]] as [ProgressRingTone, number][]).map(([tone, value]) => (
          <Captioned key={tone} caption={text(context).tones[tone]}>
            <ProgressRing size="lg" tone={tone} value={value} aria-label={text(context).tones[tone]} />
          </Captioned>
        ))}
      </Stack>
    ),
  },
  {
    // The sidebar update row (settings-review §1): the row names itself, so the ring is aria-hidden.
    name: "Sidebar update row",
    render: (context) => {
      const copy = text(context);
      return (
        <Stack gap="xs">
          <NavRow icon={<ProgressRing size="sidebar" value={0.42} aria-hidden="true" />} label={copy.downloading}
            ariaLabel={`${copy.downloading} 42%`} badge="42%" onClick={() => undefined} />
          <NavRow icon={<ProgressRing size="sidebar" indeterminate aria-hidden="true" />} label={copy.preparing} onClick={() => undefined} />
          <NavRow icon={<ProgressRing size="sidebar" value={1} tone="success" aria-hidden="true" />} label={copy.ready}
            actions={<Button size="xs" variant="outline" text={copy.restart} />} onClick={() => undefined} />
          <NavRow icon={<CircleAlert size="md" />} label={copy.failed} onClick={() => undefined} />
          <NavRow icon={<Settings size="md" />} label={copy.settings} onClick={() => undefined} />
        </Stack>
      );
    },
  },
  {
    name: "Sidebar densities",
    render: (context) => (
      <Stack gap="xs">
        {(["compact", "comfortable", "touch"] as const).map((density) => (
          <NavRow key={density} density={density} icon={<ProgressRing size="sidebar" value={0.42} aria-hidden="true" />}
            label={`${text(context).downloading} · ${density}`} badge="42%" onClick={() => undefined} />
        ))}
      </Stack>
    ),
  },
  { name: "Live", states: ["loading"], render: (context) => <LiveRing context={context} /> },
];
