import { useState } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { Button } from "../../components/Button";
import { CollapsibleList } from "../../components/Collapsible";
import { Clock3, Library, MessageSquare } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { NavRow } from "../NavRow";
import { NavDropScope, NavDropTarget } from "./NavDropTarget";

const COPY = {
  "en-US": {
    schedules: "Schedules", library: "Library", rows: ["Office chair order", "Get the September invoice", "Pay the maintenance fee", "Weekly summary page"],
    attach: "Add to ‘Get the September invoice’", save: "Save to Library as scraps", invalid: "Can't drop here", step: "Next state",
    more: ["Travel plan", "Reading list", "Release notes", "Tax documents", "Gift ideas", "Moving checklist"],
  },
  "ko-KR": {
    schedules: "예약 작업", library: "서랍", rows: ["사무용 의자 주문", "9월 청구서 받기", "관리비 이체", "주간 요약 페이지"],
    attach: "‘9월 청구서 받기’에 첨부", save: "서랍에 스크랩으로 저장", invalid: "여기에는 놓을 수 없어요", step: "다음 상태",
    more: ["여행 계획", "읽을거리", "릴리스 노트", "세금 서류", "선물 아이디어", "이사 체크리스트"],
  },
} as const;

const HEADER = { top: 0, height: 30 };

export type OutsideState = "rest" | "conversation" | "library" | "invalid";

/** Sidebar rows while picked elements are dragged over them from the browser pane. */
export function OutsideRows({ locale, state }: ShowcaseRenderContext & { state: OutsideState }) {
  const copy = COPY[locale];
  const rows = [
    { id: "schedules", label: copy.schedules, icon: <Clock3 />, drop: state === "invalid", hint: copy.invalid, invalid: true },
    { id: "library", label: copy.library, icon: <Library />, drop: state === "library", hint: copy.save, invalid: false },
    ...copy.rows.map((label, index) => ({ id: `c${index}`, label, icon: <MessageSquare />, drop: state === "conversation" && index === 1, hint: copy.attach, invalid: false })),
  ];
  return (
    <div style={{ width: 304, maxWidth: "100%" }}>
      <NavDropScope active={state !== "rest"} payload="outside" aria-label="Rows" data-ds-outside-state={state}>
        <CollapsibleList scope="outside-rows">
          {rows.map((row) => (
            <NavDropTarget key={row.id} data-ds-row={row.id} drop={row.drop ? "outside" : undefined} invalid={row.invalid} indicator={HEADER} hint={row.hint}>
              <NavRow icon={row.icon} label={row.label} onClick={() => undefined} />
            </NavDropTarget>
          ))}
        </CollapsibleList>
      </NavDropScope>
    </div>
  );
}

const STEPS: OutsideState[] = ["rest", "conversation", "library", "invalid"];

/** Steps through the outside-payload states; the rows keep their boxes in every step. */
export function OutsideSequence(context: ShowcaseRenderContext) {
  const [step, setStep] = useState(0);
  const state = STEPS[step % STEPS.length]!;
  return (
    <Stack gap="sm">
      <Button variant="outline" data-ds-motion="step" text={`${COPY[context.locale].step}: ${state}`} onClick={() => setStep(step + 1)} />
      <OutsideRows {...context} state={state} />
    </Stack>
  );
}

/** A dragged payload held near the bottom of a scrolled list: the band shows the list is scrolling. */
export function AutoScrollRows({ locale }: ShowcaseRenderContext) {
  const copy = COPY[locale];
  return (
    <div style={{ width: 304, maxWidth: "100%", height: 200, overflowY: "auto" }} data-ds-auto-scroll-list="">
      <NavDropScope active payload="outside" autoScroll="end" aria-label="Rows">
        <CollapsibleList scope="auto-scroll-rows">
          {[...copy.rows, ...copy.more].map((label) => (
            <NavDropTarget key={label} indicator={HEADER}>
              <NavRow icon={<MessageSquare />} label={label} onClick={() => undefined} />
            </NavDropTarget>
          ))}
        </CollapsibleList>
      </NavDropScope>
    </div>
  );
}
