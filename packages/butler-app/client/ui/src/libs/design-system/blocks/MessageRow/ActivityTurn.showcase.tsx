import { useState } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { Button } from "../../components/Button";
import { ChevronDown, ChevronRight } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { WorkActivityBlock } from "../WorkActivityBlock";
import { MessageRow } from "./MessageRow";
import { MessageTurnGroup } from "./MessageTurnGroup";
import { AssistantFooterSample, MESSAGE_FOOTER_LABELS } from "./MessageRow.showcaseParts";

export function ActivityTurn({ count = 1, ...context }: ShowcaseRenderContext & { running?: boolean; count?: number }) {
  return <MessageTurnGroup>{Array.from({ length: count }, (_, index) => <ActivityTurnRow key={index} {...context} />)}</MessageTurnGroup>;
}

function ActivityTurnRow({ locale, running = false }: ShowcaseRenderContext & { running?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const ko = locale === "ko-KR";
  const labels = ko ? { copy: "메시지 복사", copied: "복사됨", branchChat: "새 대화로 분기",
    branchProject: "프로젝트로 분기", completed: "응답 완료", workedFor: "9초 동안 작업" } : MESSAGE_FOOTER_LABELS;
  const summary = ko ? `활동 · 완료 · 1개 기록` : "Activity · Completed · 1 record";
  const activity = <WorkActivityBlock density="compact" title={ko ? "활동 화면 확인" : "Review the activity surface"} />;
  return <MessageRow role="assistant">
      {!running && <Stack gap="sm">
        <Button variant="inline" text={summary} aria-expanded={expanded}
          iconEnd={expanded ? <ChevronDown size="sm" /> : <ChevronRight size="sm" />}
          onClick={() => setExpanded(!expanded)} />
        {expanded && activity}
      </Stack>}
      <Typo.Body as="p">{ko ? "확인한 활동을 답변과 함께 표시합니다." : "The activity stays attached to the answer."}</Typo.Body>
      {running ? <Stack gap="sm">
        <Typo.Caption>{ko ? "현재 · 작업 중 · 1개 기록" : "Current · Working · 1 record"}</Typo.Caption>
        {activity}
        <Typo.Caption>{ko ? "응답 생성 중" : "Generating answer"}</Typo.Caption>
      </Stack> : <AssistantFooterSample text={summary} time="9:09" labels={labels} />}
    </MessageRow>;
}
