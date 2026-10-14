import { useId, useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { Search, Terminal, Wrench } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { ScrollArea } from "../ScrollArea";
import { WorkActivityBlock, type WorkActivityToolItem } from "./WorkActivityBlock";
import { WorkActivityDisclosure } from "./WorkActivityDisclosure";

export const meta: ShowcaseMeta = {
  title: "WorkActivityBlock",
  category: "Conversation & Activity",
  tags: ["conversation", "work", "progress", "tools"],
  status: "stable",
};

const copy = {
  "en-US": {
    searchTitle: "Search: gemma connection settings", search: "Search", searchDetails: "Reads environment variables and config files to find connection candidates.",
    commandDetails: "Command output is shown only as a safe summary.",
    review: "Review", reviewTitle: "Apply the verified result to the final answer",
    runningTitle: "Checking the current state with local commands", runningDescription: "Collect verifiable evidence first, then report the result.",
    doneTitle: "Applying the checked result to the answer", doneDescription: "After it finishes it keeps the same timeline shape instead of becoming a background block.",
    delegateTitle: "Delegated research", work: "Work", workerCall: "Worker call", workerDetails: "The task was handed over.", worker: "Juno · 2/3 · editing files",
    working: "Working", done: "Done", steps: ["Recall the conversation", "Confirm the request", "Check prices and stock", "Compare performance", "Review the result"],
    latestRunning: "Compare performance · Web search", latestDone: "Review the result · Done", earlier: "earlier records", details: "Details",
  },
  "ko-KR": {
    searchTitle: "검색: gemma 연결 정보", search: "검색", searchDetails: "환경 변수와 설정 파일을 읽어 연결 후보를 찾습니다.",
    commandDetails: "명령 결과는 안전한 요약으로만 표시합니다.",
    review: "검토", reviewTitle: "검증된 결과를 최종 응답에 반영",
    runningTitle: "로컬 명령으로 현재 상태를 확인합니다", runningDescription: "확인 가능한 근거를 먼저 확보하고 결과를 다음 보고에 반영합니다.",
    doneTitle: "확인한 결과를 답변에 반영합니다", doneDescription: "완료된 뒤에도 배경 블록으로 바뀌지 않고 같은 타임라인 형태를 유지합니다.",
    delegateTitle: "조사 작업 위임", work: "작업", workerCall: "워커 호출", workerDetails: "작업을 전달했습니다.", worker: "Juno · 2/3 · 파일 수정 중",
    working: "작업 중", done: "완료됨", steps: ["대화 기억 찾기", "요청 의도 확인", "가격·재고 확인", "성능 비교", "결과 검토"],
    latestRunning: "성능 비교 · 웹 검색", latestDone: "결과 검토 · 완료", earlier: "이전 기록", details: "세부 내역",
  },
} as const;

/** A folded work timeline: running work has four records so far, done work five. */
function Disclosure({ locale, live, initiallyExpanded = false }: ShowcaseRenderContext & { live: boolean; initiallyExpanded?: boolean }) {
  const text = copy[locale];
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const detailsId = useId();
  const steps = live ? text.steps.slice(0, 4) : text.steps;
  const status = live ? text.working : text.done;
  const latest = live ? text.latestRunning : text.latestDone;
  return (
    <WorkActivityDisclosure
      detailsId={detailsId}
      detailsLabel={text.details}
      expanded={expanded}
      hiddenCount={steps.length - 1}
      label={`${status}, ${latest}, ${text.earlier} ${steps.length - 1}`}
      latest={latest}
      live={live}
      onToggle={() => setExpanded((value) => !value)}
      previous={steps.at(-2)}
      status={status}
    >
      <ScrollArea maxHeight="sm">
        <Stack as="ol" gap="sm">
          {steps.map((step, index) => (
            <li key={step}>
              <WorkActivityBlock connected={index < steps.length - 1} density="compact" live={live && index === steps.length - 1} title={step} />
            </li>
          ))}
        </Stack>
      </ScrollArea>
    </WorkActivityDisclosure>
  );
}

function tools({ locale }: ShowcaseRenderContext): WorkActivityToolItem[] {
  const text = copy[locale];
  return [
    { id: "search", icon: <Search size="md" />, title: text.searchTitle, summaryLabel: text.search, details: text.searchDetails },
    { id: "command", icon: <Terminal size="md" />, title: 'Bash: env | grep -Ei "CODEX|GEMMA"', summaryLabel: "Bash", details: text.commandDetails },
    { id: "tool", icon: <Wrench size="md" />, title: text.reviewTitle, summaryLabel: text.review },
  ];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Running and done",
    states: ["running", "done", "expanded"],
    render: (context) => {
      const text = copy[context.locale];
      return (
        <Stack gap="lg">
          <WorkActivityBlock running title={text.runningTitle} description={text.runningDescription} tools={tools(context)} />
          <WorkActivityBlock title={text.doneTitle} description={text.doneDescription} tools={tools(context).slice(0, 2)} />
        </Stack>
      );
    },
  },
  {
    name: "Folded timeline (disclosure)",
    states: ["running", "done", "expanded"],
    render: (context) => (
      <Stack gap="lg">
        <Disclosure {...context} live />
        <Disclosure {...context} live={false} />
      </Stack>
    ),
  },
  {
    name: "Live dot",
    states: ["running"],
    render: (context) => {
      const text = copy[context.locale];
      return (
        <Stack as="ol" gap="sm">
          {text.steps.slice(0, 3).map((step, index) => (
            <li key={step}><WorkActivityBlock connected={index < 2} density="compact" live={index === 2} title={step} /></li>
          ))}
        </Stack>
      );
    },
  },
  {
    name: "Delegation",
    render: ({ locale }) => {
      const text = copy[locale];
      return (
        <WorkActivityBlock
          title={text.delegateTitle}
          tools={[{ id: "assignment", title: text.workerCall, summaryLabel: text.work, details: text.workerDetails,
            after: <Button variant="outline" shape="pill" text={text.worker} /> }]}
        />
      );
    },
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "open"],
  variants: ["running", "done"],
  render: (context) => (
    <Disclosure key={context.state} {...context} initiallyExpanded={context.state === "open"} live={context.variant === "running"} />
  ),
};
