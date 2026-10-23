import { useState } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { Section } from "../../components/Section";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { KanbanBoard, KanbanLane } from "./KanbanBoard";
import { KanbanCard } from "./KanbanCard";
import { KanbanDragScope } from "./KanbanDragScope";
import type { KanbanDragLabels } from "./kanbanDragLabels";
import { applyKanbanMove, type KanbanMove } from "./kanbanDragModel";

const STATUSES = ["planned", "active", "review", "blocked", "done"] as const;

const COPY = {
  "en-US": {
    backlog: "Backlog", sections: ["Milestone A", "Milestone B"], statuses: ["Planned", "In progress", "Review", "Blocked", "Done"],
    edited: "Edited 2h ago", moved: (title: string, lane: string) => `Moved “${title}” to ${lane}`, idle: "Drag a card, or focus one and press Space.",
    cards: ["Shortcut clashes with the composer", "Sort search results", "Image tool", "Visual blocks", "Long documents", "Notification settings",
      "Voice input", "Share a conversation", "Plugin permissions", "Offline models", "Release notes draft"],
  },
  "ko-KR": {
    backlog: "백로그", sections: ["마일스톤 A", "마일스톤 B"], statuses: ["예정", "진행 중", "검토 중", "막힘", "완료"],
    edited: "2시간 전 수정", moved: (title: string, lane: string) => `‘${title}’을(를) ${lane}(으)로 옮겼습니다`, idle: "카드를 끌거나, 카드에서 스페이스를 누르세요.",
    cards: ["단축키가 입력창과 충돌", "검색 결과 정렬", "이미지 도구", "시각화 블록", "긴 문서", "알림 설정",
      "음성 입력", "대화 공유", "플러그인 권한", "오프라인 모델", "릴리스 노트 초안"],
  },
} as const;

/** Korean announcements, as a product container passes them. */
export const KO_LABELS: Partial<KanbanDragLabels> = {
  instructions: "스페이스로 카드를 들고, 화살표로 옮긴 뒤 스페이스로 놓습니다. Esc로 취소합니다.",
  roleDescription: "옮길 수 있는 카드",
  lifted: (item, lane, position) => `${item} 카드를 들었습니다. ${lane}, ${position}번째.`,
  over: (item, lane, position) => `${item}: ${lane}, ${position}번째.`,
  dropped: (item, lane, position) => `${item} 카드를 ${lane} ${position}번째에 놓았습니다.`,
  cancelled: (item) => `${item} 카드 옮기기를 취소했습니다.`,
  unchanged: (item) => `${item} 카드는 그대로입니다.`,
};

type Lanes = Record<string, string[]>;

const INITIAL: Lanes = {
  backlog: ["c0", "c1", "c10"],
  "a:planned": ["c2"], "a:active": ["c3", "c4"], "a:review": [], "a:blocked": [], "a:done": ["c5"],
  "b:planned": ["c6", "c7"], "b:active": [], "b:review": [], "b:blocked": ["c8"], "b:done": ["c9"],
};

/** One wide grid lane above two boards of five status lanes; every card moves anywhere. */
export function DraggableBoards({ context }: { context: ShowcaseRenderContext }) {
  const copy = COPY[context.locale];
  const [lanes, setLanes] = useState(INITIAL);
  const [last, setLast] = useState<KanbanMove | null>(null);
  const title = (id: string) => copy.cards[Number(id.slice(1))]!;
  const laneName = (laneId: string) => laneId === "backlog" ? copy.backlog : copy.statuses[STATUSES.indexOf(laneId.slice(2) as never)]!;
  const card = (id: string) => (
    <KanbanCard key={id} itemId={id} label={title(id)} onOpen={() => undefined}>
      <Stack gap="xs">
        <Typo.Body lineClamp={2}>{title(id)}</Typo.Body>
        <Typo.Caption>{copy.edited}</Typo.Caption>
      </Stack>
    </KanbanCard>
  );
  const board = (prefix: string) => (
    <KanbanBoard scroll>
      {STATUSES.map((status) => {
        const laneId = `${prefix}:${status}`;
        return (
          <KanbanLane key={laneId} laneId={laneId} height="content" label={laneName(laneId)}
            title={`${laneName(laneId)} · ${lanes[laneId]!.length}`}>
            {lanes[laneId]!.map(card)}
          </KanbanLane>
        );
      })}
    </KanbanBoard>
  );
  return (
    <KanbanDragScope labels={context.locale === "ko-KR" ? KO_LABELS : undefined}
      onMove={(move) => { setLanes((current) => applyKanbanMove(current, move)); setLast(move); }}>
      <Stack gap="lg">
        <Typo.Caption data-kanban-last-move={last ? JSON.stringify(last) : undefined}>
          {last ? copy.moved(title(last.itemId), laneName(last.toLaneId)) : copy.idle}
        </Typo.Caption>
        <Section title={copy.backlog}>
          <KanbanBoard scroll>
            <KanbanLane laneId="backlog" height="content" layout="grid" label={copy.backlog} title={`${copy.backlog} · ${lanes.backlog!.length}`}>
              {lanes.backlog!.map(card)}
            </KanbanLane>
          </KanbanBoard>
        </Section>
        <Section title={copy.sections[0]}>{board("a")}</Section>
        <Section title={copy.sections[1]}>{board("b")}</Section>
      </Stack>
    </KanbanDragScope>
  );
}
