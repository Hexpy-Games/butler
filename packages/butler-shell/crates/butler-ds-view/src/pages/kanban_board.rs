//! KanbanBoard.showcase.tsx (+ KanbanBoard.demo.tsx): the plan board, the sideways-scrolling
//! board, and one wide grid lane above two boards of five status lanes where every card moves
//! anywhere (drag a card, or focus one and press Space, the arrow keys, Space). The lanes that
//! React builds from `Box` + `Section` are `KanbanLane`s of content height here.
use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::empty_line::EmptyLine;
use butler_ds::ui::blocks::kanban_board::{
    KanbanBoard, KanbanCard, KanbanDragLabels, KanbanDragScope, KanbanLane, KanbanMove, LaneHeight,
    LaneLayout, apply_kanban_move,
};
use butler_ds::ui::blocks::task_graph_detail::document_tile::DocumentTile;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Window};

use super::Story;
use crate::copy::Lang;

const STATUSES: [&str; 5] = ["planned", "active", "review", "blocked", "done"];

struct Copy {
    lanes: [&'static str; 4],
    open: &'static str,
    empty: &'static str,
    plans: [&'static str; 3],
    backlog: &'static str,
    sections: [&'static str; 2],
    statuses: [&'static str; 5],
    edited: &'static str,
    idle: &'static str,
    cards: [&'static str; 11],
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            lanes: ["Draft", "In progress", "Review", "Done"],
            open: "Open",
            empty: "No plans",
            plans: [
                "Ship composer Plan mode",
                "Settings hierarchy",
                "DS Viewer states",
            ],
            backlog: "Backlog",
            sections: ["Milestone A", "Milestone B"],
            statuses: ["Planned", "In progress", "Review", "Blocked", "Done"],
            edited: "Edited 2h ago",
            idle: "Drag a card, or focus one and press Space.",
            cards: [
                "Shortcut clashes with the composer",
                "Sort search results",
                "Image tool",
                "Visual blocks",
                "Long documents",
                "Notification settings",
                "Voice input",
                "Share a conversation",
                "Plugin permissions",
                "Offline models",
                "Release notes draft",
            ],
        },
        Copy {
            lanes: ["초안", "진행 중", "검토", "완료"],
            open: "열기",
            empty: "계획 없음",
            plans: ["작성기 계획 모드", "설정 구조", "DS 뷰어 상태"],
            backlog: "백로그",
            sections: ["마일스톤 A", "마일스톤 B"],
            statuses: ["예정", "진행 중", "검토 중", "막힘", "완료"],
            edited: "2시간 전 수정",
            idle: "카드를 끌거나, 카드에서 스페이스를 누르세요.",
            cards: [
                "단축키가 입력창과 충돌",
                "검색 결과 정렬",
                "이미지 도구",
                "시각화 블록",
                "긴 문서",
                "알림 설정",
                "음성 입력",
                "대화 공유",
                "플러그인 권한",
                "오프라인 모델",
                "릴리스 노트 초안",
            ],
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Plan board",
            render: plan_board,
        },
        Story {
            name: "Scrolling lanes (scrollbar on hover)",
            render: scrolling_board,
        },
        Story {
            name: "Drag between lanes and boards",
            render: drag_boards,
        },
    ]
}

fn tile(id: String, lang: Lang, index: usize, ds: &Ds) -> AnyElement {
    let c = copy(lang);
    DocumentTile::new(id, c.plans[index % c.plans.len()])
        .icon(icon(Icon::FileText, IconSize::Md, ds))
        .meta("plan")
        .action_label(c.open)
        .on_open(|_, _, _| {})
        .into_any_element()
}

fn plan_board(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    let lanes = c.lanes.iter().enumerate().map(|(index, name)| {
        let body = if index < c.plans.len() {
            tile(format!("kb-plan-tile-{index}"), lang, index, ds)
        } else {
            EmptyLine::new(c.empty).into_any_element()
        };
        KanbanLane::new(format!("kb-plan-lane-{index}"), *name).child(body)
    });
    KanbanBoard::new("kb-plan")
        .children(lanes)
        .into_any_element()
}

/// ProjectWorkBoard: eight status lanes stay in one row and overflow at every width.
fn scrolling_board(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    let lanes = c
        .lanes
        .iter()
        .chain(c.lanes.iter())
        .enumerate()
        .map(|(index, name)| {
            KanbanLane::new(format!("kb-scroll-lane-{index}"), *name)
                .height(LaneHeight::Content)
                .child(tile(format!("kb-scroll-tile-{index}"), lang, index, ds))
        });
    KanbanBoard::new("kb-scroll")
        .scroll(true)
        .children(lanes)
        .into_any_element()
}

/// Korean announcements, as a product container passes them.
fn ko_labels() -> KanbanDragLabels {
    KanbanDragLabels {
        instructions:
            "스페이스로 카드를 들고, 화살표로 옮긴 뒤 스페이스로 놓습니다. Esc로 취소합니다.".into(),
        role_description: "옮길 수 있는 카드".into(),
        lifted: Rc::new(|item: &str, lane: &str, position: usize| {
            format!("{item} 카드를 들었습니다. {lane}, {position}번째.")
        }),
        over: Rc::new(|item: &str, lane: &str, position: usize| {
            format!("{item}: {lane}, {position}번째.")
        }),
        dropped: Rc::new(|item: &str, lane: &str, position: usize| {
            format!("{item} 카드를 {lane} {position}번째에 놓았습니다.")
        }),
        cancelled: Rc::new(|item: &str| format!("{item} 카드 옮기기를 취소했습니다.")),
        unchanged: Rc::new(|item: &str| format!("{item} 카드는 그대로입니다.")),
    }
}

fn initial() -> Vec<(SharedString, Vec<SharedString>)> {
    let lane = |id: &str, cards: &[&str]| {
        (
            SharedString::from(id.to_owned()),
            cards
                .iter()
                .map(|c| SharedString::from((*c).to_owned()))
                .collect(),
        )
    };
    vec![
        lane("backlog", &["c0", "c1", "c10"]),
        lane("a:planned", &["c2"]),
        lane("a:active", &["c3", "c4"]),
        lane("a:review", &[]),
        lane("a:blocked", &[]),
        lane("a:done", &["c5"]),
        lane("b:planned", &["c6", "c7"]),
        lane("b:active", &[]),
        lane("b:review", &[]),
        lane("b:blocked", &["c8"]),
        lane("b:done", &["c9"]),
    ]
}

fn card_title(c: &Copy, id: &str) -> &'static str {
    id.strip_prefix('c')
        .and_then(|n| n.parse::<usize>().ok())
        .and_then(|n| c.cards.get(n))
        .copied()
        .unwrap_or("")
}

fn lane_name(c: &Copy, lane: &str) -> &'static str {
    let status = lane.split(':').next_back().unwrap_or(lane);
    STATUSES
        .iter()
        .position(|s| *s == status)
        .map_or(c.backlog, |at| c.statuses[at])
}

fn moved_text(lang: Lang, title: &str, lane: &str) -> String {
    lang.pick(
        format!("Moved “{title}” to {lane}"),
        format!("‘{title}’을(를) {lane}(으)로 옮겼습니다"),
    )
}

/// One lane of the demo with its cards.
fn demo_lane(c: &Copy, lane: &(SharedString, Vec<SharedString>), layout: LaneLayout) -> KanbanLane {
    let name = lane_name(c, &lane.0);
    let cards = lane.1.iter().map(|id| {
        let title = card_title(c, id);
        let body = Stack::new()
            .gap(Space::Xs)
            .child(Typo::body(title).line_clamp(2))
            .child(Typo::caption(c.edited).tone(Tone::Tertiary));
        KanbanCard::new(id.clone(), title)
            .on_open(|_, _| {})
            .anchor(format!("kanban-card-{id}"))
            .child(body)
    });
    KanbanLane::new(
        format!("kb-drag-lane-{}", lane.0),
        format!("{name} · {}", lane.1.len()),
    )
    .lane_id(lane.0.clone())
    .label(name)
    .height(LaneHeight::Content)
    .layout(layout)
    .children(cards)
}

fn drag_boards(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let key = format!("kb-drag-{lang:?}");
    let lanes = window.use_keyed_state(key.clone(), cx, |_, _| initial());
    let last = window.use_keyed_state(format!("{key}-last"), cx, |_, _| {
        SharedString::from(copy(lang).idle)
    });
    let (state, caption) = (lanes.read(cx).clone(), last.read(cx).clone());
    let board = |prefix: &str| {
        let cells = state
            .iter()
            .filter(|(id, _)| id.starts_with(prefix))
            .map(|lane| demo_lane(&c, lane, LaneLayout::List));
        KanbanBoard::new(format!("kb-drag-board-{prefix}"))
            .scroll(true)
            .children(cells)
    };
    let backlog = state
        .iter()
        .find(|(id, _)| &**id == "backlog")
        .map(|lane| demo_lane(&c, lane, LaneLayout::Grid));
    let section = |title: &'static str, body: KanbanBoard| {
        Stack::new()
            .gap(Space::Md)
            .child(Typo::section_title(title))
            .child(body)
    };
    let page = Stack::new()
        .gap(Space::Lg)
        .child(Typo::caption(caption))
        .child(section(
            c.backlog,
            KanbanBoard::new("kb-drag-backlog")
                .scroll(true)
                .children(backlog),
        ))
        .child(section(c.sections[0], board("a:")))
        .child(section(c.sections[1], board("b:")));
    let scope = KanbanDragScope::new(format!("kb-drag-scope-{lang:?}")).on_move(
        move |mv: KanbanMove, _, cx| {
            let c = copy(lang);
            let text = moved_text(
                lang,
                card_title(&c, &mv.item_id),
                lane_name(&c, &mv.to_lane_id),
            );
            lanes.update(cx, |lanes, cx| {
                *lanes = apply_kanban_move(lanes, &mv);
                cx.notify();
            });
            last.update(cx, |last, cx| {
                *last = text.into();
                cx.notify();
            });
        },
    );
    let scope = match lang {
        Lang::Ko => scope.labels(ko_labels()),
        Lang::En => scope,
    };
    scope.child(page).into_any_element()
}
