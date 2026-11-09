//! ManagementPage.showcase.tsx (+ `.asideDemo.tsx`): a page with a main column and a side panel,
//! over a wallpaper with and without the calm veil, and with a detail in its aside, docked on a
//! 1280px page and floating on a narrow one. The wallpaper is a still gradient (the live module
//! is a block of a later batch), the composer a stand-in, and `onColumnRect` is not ported.
use butler_ds::tokens::{Color, Length};
use butler_ds::ui::blocks::dashboard_header::DashboardHeader;
use butler_ds::ui::blocks::management_page::{
    BackgroundTreatment, FooterPlacement, ManagementPage, ManagementPagePanel,
};
use butler_ds::ui::blocks::scope;
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::card::{Card, CardPadding};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{
    Border, Box, Columns, Grid, GridCross, Preset, Radius, Responsive, Space, Stack,
};
use butler_ds::ui::typo::{Role, Tone, Typo};
use gpui::{
    AnyElement, App, IntoElement, ParentElement as _, RenderOnce, Styled as _, Window, div, px,
};

use super::{Story, sub};
use crate::copy::Lang;
use crate::standins_window::scaled_frame;

struct Copy {
    title: &'static str,
    meta: &'static str,
    action: &'static str,
    main: &'static str,
    aside: &'static str,
    project: &'static str,
    description: &'static str,
    calm: &'static str,
    none: &'static str,
    label: &'static str,
    prompt: &'static str,
    columns: [(&'static str, [&'static str; 2]); 3],
    task: &'static str,
    state: &'static str,
    intro: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            title: "Schedules",
            meta: "3 prompts scheduled",
            action: "New",
            main: "Scheduled prompts",
            aside: "Recent runs",
            project: "Butler",
            description: "Desktop client and gateway. Wallpaper upgrade in progress.",
            calm: "Calm treatment: the veil lowers the wallpaper's contrast.",
            none: "No treatment: the wallpaper as is.",
            label: "Task details",
            prompt: "Ask about this project",
            columns: [
                ("Planned", ["Shortcut input conflict", "Release notes"]),
                ("In progress", ["Session details area", ""]),
                ("Done", ["Card radius", ""]),
            ],
            task: "Session details area",
            state: "In progress · Running",
            intro: "Show the session's open requests, task and results beside the conversation.",
        },
        Copy {
            title: "예약 작업",
            meta: "예약된 프롬프트 3개",
            action: "새로 만들기",
            main: "예약된 프롬프트",
            aside: "최근 실행",
            project: "버틀러",
            description: "데스크톱 클라이언트와 게이트웨이. 월페이퍼 업그레이드 진행 중.",
            calm: "차분한 처리: 베일이 월페이퍼 대비를 낮춥니다.",
            none: "처리 없음: 월페이퍼 그대로.",
            label: "과제 정보",
            prompt: "이 프로젝트에 대해 말해 보세요",
            columns: [
                ("계획", ["단축키 입력창 충돌", "릴리스 노트"]),
                ("진행 중", ["세션 정보 영역", ""]),
                ("완료", ["카드 모서리", ""]),
            ],
            task: "세션 정보 영역",
            state: "진행 중 · 실행",
            intro: "대화 옆에 세션의 열린 요청, 과제, 결과물을 보여 줍니다.",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Page with main and aside",
            render: plain,
        },
        Story {
            name: "Page over a wallpaper",
            render: |l, _, c| wallpaper(l, "mp-wallpaper", BackgroundTreatment::Calm, c),
        },
        Story {
            name: "Background without treatment",
            render: |l, _, c| wallpaper(l, "mp-bare", BackgroundTreatment::None, c),
        },
        Story {
            name: "Aside docked (wide page)",
            render: docked,
        },
        Story {
            name: "Aside floating (narrow page)",
            render: floating,
        },
    ]
}

/// A bordered, clipped stage of a fixed height.
fn stage(height: f32, content: AnyElement, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    div()
        .relative()
        .h(px(height))
        .overflow_hidden()
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .rounded(ds.len(Length::RadiusPanel))
        .child(content)
        .into_any_element()
}

fn pane(text: &'static str) -> Box {
    Box::new()
        .border(Border::Hairline)
        .radius(Radius::Control)
        .padding(Space::Lg)
        .child(Typo::body(text))
}

fn main_aside(id: &'static str, c: &Copy) -> Grid {
    Grid::new(id)
        .columns(Columns::Responsive(Responsive {
            compact: None,
            base: Preset::Fixed(1),
            wide: Some(Preset::MainAside),
        }))
        .page_container()
        .gap(Space::Xl)
        .child(pane(c.main))
        .child(pane(c.aside))
}

fn plain(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let page = ManagementPage::new("mp-plain")
        .child(
            DashboardHeader::new(c.title).meta(c.meta).action(
                Button::new("mp-plain-new")
                    .variant(Variant::Outline)
                    .text(c.action),
            ),
        )
        .child(main_aside("mp-plain-grid", &c));
    stage(440., page.into_any_element(), cx)
}

/// The wallpaper's place: a still gradient stands in for the live module.
fn backdrop(cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    div()
        .size_full()
        .bg(gpui::linear_gradient(
            135.,
            gpui::linear_color_stop(ds.color(Color::ButlerInkBlue), 0.),
            gpui::linear_color_stop(ds.color(Color::ButlerInkPink), 1.),
        ))
        .into_any_element()
}

fn wallpaper(
    lang: Lang,
    id: &'static str,
    treatment: BackgroundTreatment,
    cx: &mut App,
) -> AnyElement {
    let c = copy(lang);
    let note = if treatment == BackgroundTreatment::Calm {
        c.calm
    } else {
        c.none
    };
    let page = ManagementPage::new(id)
        .background(backdrop(cx))
        .background_treatment(treatment)
        .child(
            ManagementPagePanel::new().child(
                DashboardHeader::new(c.project)
                    .description(c.description)
                    .action(
                        Button::new(sub(id, "new"))
                            .variant(Variant::Outline)
                            .text(c.action),
                    ),
            ),
        )
        .child(
            ManagementPagePanel::new()
                .child(Typo::body(note))
                .child(main_aside("mp-wallpaper-grid", &c)),
        );
    stage(440., page.into_any_element(), cx)
}

/// The selected task: title, state and its description (`TaskDetail`).
#[derive(IntoElement)]
struct TaskDetail(Lang);

impl RenderOnce for TaskDetail {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let c = copy(self.0);
        Stack::new()
            .gap(Space::Md)
            .child(
                Stack::new()
                    .gap(Space::Xs)
                    .child(Typo::new(Role::PanelTitle, c.task))
                    .child(Typo::caption(c.state).tone(Tone::Secondary)),
            )
            .child(Typo::body(c.intro))
    }
}

/// The overlay composer's place: it shares the page's column (ComposerCard stand-in).
#[derive(IntoElement)]
struct Composer(&'static str);

impl RenderOnce for Composer {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let column = scope::conversation(cx).unwrap_or_default();
        div()
            .absolute()
            .bottom(ds.len(Length::SpaceLg))
            .left(px(column.column_left))
            .w(px(column.column_width.max(0.)))
            .p(ds.len(Length::SpaceMd))
            .rounded(ds.len(Length::RadiusComposer))
            .border(ds.len(Length::BorderHairline))
            .border_color(ds.color(Color::ComposerGlassBorder))
            .bg(ds.color(Color::ComposerGlassBg))
            .child(Typo::body(self.0).tone(Tone::Secondary))
    }
}

/// `BoardWithTask`: a project board with the selected task in the page's aside and the overlay
/// composer.
fn board(lang: Lang, id: &'static str, float_open: bool) -> ManagementPage {
    let c = copy(lang);
    let columns = c.columns.map(|(name, cards)| {
        Stack::new()
            .gap(Space::Sm)
            .child(Typo::caption(name).tone(Tone::Secondary))
            .children(
                cards
                    .into_iter()
                    .filter(|card| !card.is_empty())
                    .map(|card| {
                        Card::new(card)
                            .padding(CardPadding::Sm)
                            .interactive()
                            .selected(card == c.task)
                            .child(Typo::body(card))
                    }),
            )
    });
    ManagementPage::new(id)
        .aside_float_open(float_open)
        .aside_label(c.label)
        .aside(move |_| TaskDetail(lang).into_any_element())
        .footer_placement(FooterPlacement::Overlay)
        .footer_reserve(48.)
        .footer(Composer(c.prompt))
        .child(
            DashboardHeader::new(c.project)
                .description(c.description)
                .action(
                    Button::new(sub(id, "new"))
                        .variant(Variant::Outline)
                        .text(c.action),
                ),
        )
        .child(
            Grid::new(sub(id, "columns"))
                .gap(Space::Md)
                .cross(GridCross::Start)
                .children(columns),
        )
}

fn docked(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let page = board(lang, "mp-docked", true).into_any_element();
    scaled_frame("mp-docked-frame", (1280., 640.), page, window, cx)
}

fn floating(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let page = board(lang, "mp-floating", true).into_any_element();
    div()
        .max_w(px(720.)) // DS: ManagementPage.showcase.module.css:12
        .child(stage(560., page, cx))
        .into_any_element()
}
