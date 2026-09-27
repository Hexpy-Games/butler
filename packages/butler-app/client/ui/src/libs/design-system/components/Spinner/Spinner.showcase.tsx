import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Button } from "../Button";
import { ButtonContainer } from "../ButtonContainer";
import { CheckIcon, Circle, CircleAlert, ICON_SIZE, MessageSquare } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { LoadingIndicator } from "../LoadingIndicator";
import { Spinner } from "./Spinner";

export const meta: ShowcaseMeta = {
  title: "Spinner",
  category: "Feedback",
  tags: ["loading", "spinner", "busy", "indeterminate", "motion"],
  status: "stable",
};

const labels = {
  "en-US": {
    loading: "Loading records", syncing: "Syncing", synced: "Synced", complete: "Complete loading", again: "Load again",
    replay: "Replay", session: "Token page review", running: "Running", failed: "Failed", idle: "Waiting",
  },
  "ko-KR": {
    loading: "기록을 불러오는 중", syncing: "동기화 중", synced: "동기화됨", complete: "불러오기 완료", again: "다시 불러오기",
    replay: "다시 재생", session: "토큰 페이지 검토", running: "진행 중", failed: "실패", idle: "대기 중",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

function BusyButton({ context }: { context: ShowcaseRenderContext }) {
  const [busy, setBusy] = useState(true);
  const [run, setRun] = useState(0);
  const copy = text(context);
  return (
    <Stack gap="md">
      <Stack key={run} align="row" gap="lg" cross="center" wrap>
        {(["sm", "md", "lg", "xl", "2xl"] as const).map((token) => (
          <Stack key={token} gap="sm" cross="center">
            <Spinner size={ICON_SIZE[token]} />
            <Typo.Caption>{`icon-${token} · ${ICON_SIZE[token]}px`}</Typo.Caption>
          </Stack>
        ))}
      </Stack>
      <ButtonContainer size="sm">
        <Button size="sm" disabled={busy} aria-busy={busy || undefined}>
          <LoadingIndicator state={busy ? "loading" : "done"} size={ICON_SIZE.sm} />
          {busy ? copy.syncing : copy.synced}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setBusy(!busy)} text={busy ? copy.complete : copy.again} />
        <Button size="sm" variant="borderless" data-ds-motion="spinner-replay" onClick={() => setRun(run + 1)} text={copy.replay} />
      </ButtonContainer>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Sizes and busy button", states: ["loading"], render: (context) => <BusyButton context={context} /> },
  {
    // SummaryPanel / SpaceActivity: the spinner replaces the status icon while running.
    name: "Status icon slot",
    render: (context) => (
      <Stack gap="sm">
        {([["running", <Spinner key="s" size={ICON_SIZE.lg} />], ["failed", <CircleAlert key="f" size="lg" />], ["idle", <Circle key="i" size="lg" />]] as const)
          .map(([state, icon]) => (
            <Stack align="row" cross="center" gap="sm" key={state}>{icon}<Typo.Body>{text(context)[state]}</Typo.Body></Stack>
          ))}
      </Stack>
    ),
  },
  {
    name: "Running session button",
    render: (context) => (
      <Stack align="row" gap="sm">
        <Button variant="borderless" size="xs"><Spinner /><Typo.Text truncate>{text(context).session}</Typo.Text></Button>
        <Button variant="borderless" size="xs"><MessageSquare /><Typo.Text truncate>{text(context).session}</Typo.Text></Button>
      </Stack>
    ),
  },
  { name: "Labelled (status role)", render: (context) => <Spinner size={18} label={text(context).loading} /> },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "loading", "disabled"],
  render: (context) => (
    <Button size="sm" disabled={context.state !== "default"} aria-busy={context.state === "loading" || undefined}>
      {context.state === "loading" ? <Spinner size={ICON_SIZE.sm} /> : <CheckIcon size="sm" aria-hidden />}
      {context.state === "loading" ? text(context).syncing : text(context).synced}
    </Button>
  ),
};
