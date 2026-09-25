import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { Search, Terminal, Wrench } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { WorkActivityBlock, type WorkActivityToolItem } from "./WorkActivityBlock";

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
  },
  "ko-KR": {
    searchTitle: "검색: gemma 연결 정보", search: "검색", searchDetails: "환경 변수와 설정 파일을 읽어 연결 후보를 찾습니다.",
    commandDetails: "명령 결과는 안전한 요약으로만 표시합니다.",
    review: "검토", reviewTitle: "검증된 결과를 최종 응답에 반영",
    runningTitle: "로컬 명령으로 현재 상태를 확인합니다", runningDescription: "확인 가능한 근거를 먼저 확보하고 결과를 다음 보고에 반영합니다.",
    doneTitle: "확인한 결과를 답변에 반영합니다", doneDescription: "완료된 뒤에도 배경 블록으로 바뀌지 않고 같은 타임라인 형태를 유지합니다.",
    delegateTitle: "조사 작업 위임", work: "작업", workerCall: "워커 호출", workerDetails: "작업을 전달했습니다.", worker: "Juno · 2/3 · 파일 수정 중",
  },
} as const;

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
