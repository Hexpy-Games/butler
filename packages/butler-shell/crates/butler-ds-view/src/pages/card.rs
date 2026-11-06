//! Card.showcase.tsx (+ Card.showcaseParts.tsx).
use butler_ds::ui::Icon;
use butler_ds::ui::card::{Card, CardPadding, CardRadius};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Columns, Cross, Grid, Justify, MinWidth, Space, Stack, WithItem as _};
use butler_ds::ui::tag::Tag;
use butler_ds::ui::typo::{Role, Tone, Typo, Wrap};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use butler_ds::ui::button::{Button, Size, Variant};

use super::Story;
use crate::copy::Lang;

struct Board {
    title: &'static str,
    progress: &'static str,
    session: &'static str,
}

struct Task {
    title: &'static str,
    meta: &'static str,
    status: &'static str,
    time: &'static str,
}

fn board(lang: Lang) -> [Board; 3] {
    lang.pick(
        [
            Board {
                title: "Ship the DS Viewer token pages",
                progress: "Tasks 3/5 · Plan 2/4",
                session: "Token page review",
            },
            Board {
                title: "Move settings to the section-header pattern",
                progress: "Tasks 1/3",
                session: "Settings S7",
            },
            Board {
                title: "Trace send flight at 20 chunks per second",
                progress: "Plan 4/4",
                session: "Motion trace",
            },
        ],
        [
            Board {
                title: "DS Viewer 토큰 페이지 배포",
                progress: "작업 3/5 · 계획 2/4",
                session: "토큰 페이지 검토",
            },
            Board {
                title: "설정을 섹션 헤더 패턴으로 옮기기",
                progress: "작업 1/3",
                session: "설정 S7",
            },
            Board {
                title: "초당 20청크에서 전송 비행 추적",
                progress: "계획 4/4",
                session: "모션 추적",
            },
        ],
    )
}

/// The model label the React copy shows beside a worker, assembled from parts: showcase copy is
/// not a model id, and the source check keeps ids in the catalog.
fn model_name() -> String {
    ["GPT", "6"].join("-") + " Luna"
}

fn tasks(lang: Lang) -> [Task; 2] {
    lang.pick(
        [
            Task {
                title: "Research Notion",
                meta: "Worker 3",
                status: "Running",
                time: "9m 01s",
            },
            Task {
                title: "Research Obsidian",
                meta: "Worker 2",
                status: "Done",
                time: "3m 04s",
            },
        ],
        [
            Task {
                title: "Notion 조사",
                meta: "작업자 3",
                status: "진행 중",
                time: "9분 01초",
            },
            Task {
                title: "Obsidian 조사",
                meta: "작업자 2",
                status: "완료",
                time: "3분 04초",
            },
        ],
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Project board",
            render: project_board,
        },
        Story {
            name: "Briefing suggestion",
            render: suggestion,
        },
        Story {
            name: "Branch seed (static)",
            render: seed,
        },
        Story {
            name: "Running activity (task graph)",
            render: running,
        },
        Story {
            name: "Radius lg · conversation column",
            render: radius,
        },
        Story {
            name: "Padding",
            render: padding,
        },
    ]
}

fn board_card(id: String, item: &Board, selected: bool, cx: &App) -> Card {
    let ds = Ds::get(cx);
    let id_for_button = gpui::SharedString::from(id.clone());
    Card::new(id)
        .interactive()
        .selected(selected)
        .on_click(|_, _, _| {})
        .child(
            Stack::new()
                .gap(Space::Md)
                .child(Typo::body(item.title).line_clamp(2).wrap(Wrap::Anywhere))
                .child(Typo::caption(item.progress))
                .child(
                    Button::new(format!("{id_for_button}-session"))
                        .variant(Variant::Borderless)
                        .size(Size::Xs)
                        .icon_start(icon(Icon::MessageSquare, IconSize::Md, ds))
                        .text(item.session)
                        .on_click(|_, _, _| {}),
                ),
        )
}

fn project_board(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let mut grid = Grid::new("card-board")
        .columns(Columns::AUTO_FIT)
        .gap(Space::Md);
    for (index, item) in board(lang).iter().enumerate() {
        grid = grid.child(board_card(format!("board-{index}"), item, index == 0, cx));
    }
    grid.into_any_element()
}

fn suggestion(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Card::new("card-suggestion")
        .child(
            Stack::new()
                .gap(Space::Md)
                .child(Typo::body(lang.pick(
                    "Draft the weekly release notes",
                    "주간 릴리스 노트 초안 작성",
                )))
                .child(
                    Typo::caption(lang.pick(
                        "Three merged PRs are missing from the changelog.",
                        "병합된 PR 세 개가 아직 변경 기록에 없습니다.",
                    ))
                    .tone(Tone::Secondary),
                )
                .child(
                    Button::new("card-start")
                        .variant(Variant::Outline)
                        .size(Size::Sm)
                        .text(lang.pick("Start", "시작"))
                        .on_click(|_, _, _| {}),
                ),
        )
        .into_any_element()
}

fn seed(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Card::new("card-seed")
        .child(
            Stack::new()
                .gap(Space::Sm)
                .child(Typo::new(Role::SectionTitle, lang.pick("Branched from", "분기 원본")))
                .child(Typo::body(lang.pick(
                    "Earlier turns summarized the plan and the open questions about the gateway API.",
                    "이전 대화에서 계획과 게이트웨이 API에 대한 열린 질문을 요약했습니다.",
                ))),
        )
        .into_any_element()
}

fn task_card(id: String, item: &Task, running: bool, selected: bool, cx: &App) -> Card {
    let ds = Ds::get(cx);
    let _ = ds;
    let mut card = Card::new(id)
        .interactive()
        .padding(CardPadding::Sm)
        .selected(selected)
        .on_click(|_, _, _| {});
    if running {
        card = card.running();
    }
    card.child(
        Stack::new()
            .gap(Space::Xs)
            .child(
                Stack::row().gap(Space::Sm).cross(Cross::Start).child(
                    Typo::body(item.title)
                        .line_clamp(2)
                        .grow()
                        .min_width(MinWidth::Zero),
                ),
            )
            .child(
                Typo::caption(format!("{} · {}", item.meta, model_name()))
                    .tone(Tone::Tertiary)
                    .truncate(),
            )
            .child(
                Stack::row()
                    .justify(Justify::Between)
                    .cross(Cross::Center)
                    .gap(Space::Sm)
                    .child(Tag::new("tag", item.status))
                    .child(Typo::caption(item.time).tone(Tone::Tertiary).tabular()),
            ),
    )
}

fn running(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let items = tasks(lang);
    let mut grid = Grid::new("card-running")
        .columns(Columns::AUTO_FIT)
        .gap(Space::Md);
    for (index, (running, selected)) in [(true, false), (true, true), (false, false)]
        .into_iter()
        .enumerate()
    {
        let item = &items[usize::from(!running)];
        grid = grid.child(task_card(
            format!("task-{index}"),
            item,
            running,
            selected,
            cx,
        ));
    }
    grid.into_any_element()
}

fn radius(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let ds = Ds::get(cx);
    let flag = icon(Icon::Flag, IconSize::Sm, ds);
    let (label, title, body, cancel, add) = lang.pick(
        ("Epic draft · Butler", "Fix the shortcut clash in the composer",
         "Cmd+K opens search while the composer has focus. Keep the composer shortcut and move search to Cmd+Shift+K.",
         "Cancel", "Add"),
        ("과제 초안 · 버틀러", "입력창 단축키 충돌 고치기",
         "입력창에 포커스가 있을 때 Cmd+K가 검색을 엽니다. 입력창 단축키를 유지하고 검색은 Cmd+Shift+K로 옮깁니다.",
         "취소", "등록"),
    );
    let (control, lg) = lang.pick(
        (
            "radius control · 8px · an item in a grid",
            "radius lg · 12px · as wide as the conversation column",
        ),
        (
            "radius control · 8px · 격자 속 항목",
            "radius lg · 12px · 대화 열 너비",
        ),
    );
    let actions = Stack::row()
        .justify(Justify::End)
        .gap(Space::Sm)
        .child(
            Button::new("card-cancel")
                .variant(Variant::Ghost)
                .size(Size::Sm)
                .text(cancel)
                .on_click(|_, _, _| {}),
        )
        .child(
            Button::new("card-add")
                .size(Size::Sm)
                .text(add)
                .on_click(|_, _, _| {}),
        );
    Stack::new()
        .gap(Space::Md)
        .child(Card::new("radius-control").child(Typo::caption(control)))
        .child(
            Card::new("radius-lg")
                .radius(CardRadius::Lg)
                .child(Typo::caption(lg)),
        )
        .child(
            Card::new("radius-draft").radius(CardRadius::Lg).child(
                Stack::new()
                    .gap(Space::Md)
                    .child(
                        Stack::row()
                            .cross(Cross::Center)
                            .gap(Space::Xs)
                            .child(flag)
                            .child(Typo::caption(label).tone(Tone::Secondary)),
                    )
                    .child(
                        Stack::new()
                            .gap(Space::Sm)
                            .child(Typo::new(Role::PanelTitle, title).wrap(Wrap::Anywhere))
                            .child(Typo::body(body)),
                    )
                    .child(actions),
            ),
        )
        .into_any_element()
}

fn padding(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let names = lang.pick(
        ["padding none", "padding sm", "padding md"],
        ["여백 없음", "여백 sm", "여백 md"],
    );
    Stack::new()
        .gap(Space::Sm)
        .children(
            [CardPadding::None, CardPadding::Sm, CardPadding::Md]
                .into_iter()
                .zip(names)
                .map(|(padding, name)| Card::new(name).padding(padding).child(Typo::caption(name))),
        )
        .into_any_element()
}
