import type { ReactNode } from "react";
import type { ShowcaseRenderContext, ShowcaseStory } from "../../../showcase";
import { IconButton } from "../../../components/IconButton";
import { IconSlot } from "../../../components/IconSlot";
import { CircleAlert, Eye, Notebook, Play } from "../../../components/Icons";
import { Spinner } from "../../../components/Spinner";
import { Stack } from "../../../components/Stack";
import { Typo } from "../../../components/Typo";
import { NavRow } from "../NavRow";
import { NavRowChildren } from "../NavRowChildren";
import { NavRowSwap } from "../NavRowSwap";

const copy = {
  "en-US": { parent: "Find the sign-in error", working: "Working", details: "View progress details", resume: "Resume", approval: "Needs approval",
    children: ["Review the token refresh logic", "Tidy the regression tests", "Group the failure logs by hour"] },
  "ko-KR": { parent: "로그인 오류 원인 찾기", working: "작업 중", details: "진행 상세 보기", resume: "이어서 진행", approval: "허용 대기",
    children: ["토큰 갱신 로직 검토", "회귀 테스트 정리", "실패 로그를 시간대별로 정리"] },
} as const;

/**
 * A chat's subtasks at each density: the guide sits on the parent's icon column, the labels start
 * where the parent's starts, and every trailing mark (in the parent's slot shape) on its status column.
 */
export function NestedRows({ locale }: ShowcaseRenderContext) {
  const text = copy[locale];
  const details = <IconButton label={text.details}><Eye size="sm" /></IconButton>;
  const mark = (icon: ReactNode, label: string) => <IconSlot size="sidebar" minHeight="line" passive role="status" aria-label={label}>{icon}</IconSlot>;
  return (
    <Stack gap="lg">
      {(["compact", "comfortable", "touch"] as const).map((density) => (
        <Stack gap="none" key={density}>
          <NavRow density={density} icon={<Notebook size="md" />} label={`${text.parent} · ${density}`} onClick={() => undefined}
            actions={<NavRowSwap rest={mark(<Spinner />, text.working)}>{details}</NavRowSwap>} />
          <NavRowChildren density={density}>
            <NavRow density={density} reserveIcon label={text.children[0]} onClick={() => undefined}
              actions={<NavRowSwap rest={<Typo.Caption tone="secondary" numeric="tabular" wrap="nowrap">3/5</Typo.Caption>}>{details}</NavRowSwap>} />
            <NavRow density={density} reserveIcon label={text.children[1]} onClick={() => undefined}
              actions={<IconButton label={text.resume}><Play /></IconButton>} />
            <NavRow density={density} reserveIcon label={text.children[2]} onClick={() => undefined}
              actions={<NavRowSwap rest={mark(<CircleAlert />, text.approval)}>{details}</NavRowSwap>} />
          </NavRowChildren>
        </Stack>
      ))}
    </Stack>
  );
}

/** A chat's subtasks (NavRowChildren): the guide on the parent's icon column, marks on its status column. */
export const nestedRowsStory: ShowcaseStory = {
  name: "Nested rows (NavRowChildren)",
  widths: ["320", "375", "app"],
  render: (context) => <NestedRows {...context} />,
};
