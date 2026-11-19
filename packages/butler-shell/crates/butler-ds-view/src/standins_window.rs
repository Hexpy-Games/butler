//! Stand-ins for the demo window the shell showcases share (BrowserPane `fixtures/`
//! `ConversationFrame`, `ScaledFrame`, `BrowserDemo`; AdaptiveShell `FileViewerDemo`): a window
//! laid out at a fixed size and scaled to the story width, the demo sidebar and chat, and the
//! pane that stands for the browser and the file viewer. Not part of `butler-ds`.
use butler_ds::tokens::{Color, Length};
use butler_ds::ui::blocks::adaptive_shell::parts::ShellCard;
use butler_ds::ui::blocks::measure;
use butler_ds::ui::blocks::sidebar_shell::{SidebarShell, traffic_space};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Box, Justify, Radius, Space, Stack, Surface};
use butler_ds::ui::typo::{Role, Tone, Typo};
use gpui::{
    AnyElement, App, ElementId, IntoElement as _, ParentElement as _, Styled as _, Window, div, px,
};

use crate::copy::Lang;
use crate::pages::CanvasWidth;
use crate::standins_shell::demo_sidebar_rows;

/// The copy of the browser demo and the demo sidebar (`BROWSER_DEMO_COPY`, `SIDEBAR`).
pub(crate) struct Demo {
    pub(crate) browser: &'static str,
    pub(crate) conversation: &'static str,
    pub(crate) resize_chat: &'static str,
    pub(crate) drag_to_resize: &'static str,
    pub(crate) chat: [&'static str; 3],
    pub(crate) nav: [&'static str; 5],
    pub(crate) spaces: &'static str,
    pub(crate) rows: [&'static str; 4],
    pub(crate) show_sidebar: &'static str,
    pub(crate) inspector: &'static str,
    pub(crate) hide_browser: &'static str,
    pub(crate) actions: &'static str,
    pub(crate) tab_title: &'static str,
    pub(crate) url: &'static str,
}

pub(crate) fn demo(lang: Lang) -> Demo {
    lang.pick(
        Demo {
            browser: "Browser",
            conversation: "Office chair order",
            resize_chat: "Resize conversation",
            drag_to_resize: "Drag to resize",
            chat: [
                "Remember the chairs from last week? The ones with lumbar support.",
                "Yes, three mesh chairs with lumbar support, ₩120–190k.",
                "Order the cheapest one arriving tomorrow.",
            ],
            nav: ["New chat", "Search", "Schedules", "Browser", "Library"],
            spaces: "Spaces",
            rows: [
                "Office chair order",
                "Get the September invoice",
                "Pay the maintenance fee",
                "Weekly summary page",
            ],
            show_sidebar: "Show sidebar",
            inspector: "Show inspector",
            hide_browser: "Hide browser",
            actions: "Conversation actions",
            tab_title: "Office chairs : Daily Goods",
            url: "https://shop.example.com/search?q=office-chair",
        },
        Demo {
            browser: "브라우저",
            conversation: "사무용 의자 주문",
            resize_chat: "대화 너비 조절",
            drag_to_resize: "드래그하여 크기 조절",
            chat: [
                "지난주에 보던 의자들 기억나? 허리 받침 있는 걸로.",
                "네, 요추 지지대가 있는 메쉬 의자 세 개를 보셨어요. 가격대는 12~19만원이었습니다.",
                "그중에 내일 도착하는 제일 싼 걸로 주문해줘.",
            ],
            nav: ["새 대화", "검색", "예약 작업", "브라우저", "서랍"],
            spaces: "스페이스",
            rows: [
                "사무용 의자 주문",
                "9월 청구서 받기",
                "관리비 이체",
                "주간 요약 페이지",
            ],
            show_sidebar: "사이드바 보기",
            inspector: "인스펙터 보기",
            hide_browser: "브라우저 닫기",
            actions: "대화 작업",
            tab_title: "사무용 의자 : 데일리굿즈",
            url: "https://shop.example.com/search?q=office-chair",
        },
    )
}

/// `ScaledFrame`: a window laid out at `width` x `height` and scaled down to the story width, so
/// a whole frame reads at every viewer width. The scaled frame is a bordered, clipped box.
pub(crate) fn scaled_frame(
    id: impl Into<ElementId>,
    (width, height): (f32, f32),
    content: AnyElement,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let (seen, recorder) = measure::track(id, window, cx);
    let ds = Ds::get(cx);
    let border = f32::from(ds.len(Length::BorderHairline));
    // The host's content width: measured, and before that the forced canvas width.
    let measured = f32::from(seen.width);
    let available = if measured > 0. {
        measured
    } else {
        cx.try_global::<CanvasWidth>()
            .map_or(width, |forced| forced.0 - 2. * border)
    };
    let scale = (available / width).min(1.);
    let host_height = (height * scale).round();
    div()
        .relative()
        .w_full()
        .h(px(host_height))
        .rounded(ds.len(Length::RadiusPanel))
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .child(recorder)
        .child(
            div()
                .absolute()
                .top_0()
                .left_0()
                .w(px(width))
                .h(px(height))
                .scale(scale)
                .transform_origin(0., 0.)
                .child(content),
        )
        .into_any_element()
}

/// `DemoSidebar`: the nav rows and the spaces, in a SidebarShell without edge fade.
pub(crate) fn demo_sidebar(
    id: &'static str,
    lang: Lang,
    collapsed: bool,
    cx: &App,
) -> SidebarShell {
    let d = demo(lang);
    let mut shell = SidebarShell::new(id)
        .scroll_fade(false)
        .titlebar(traffic_space())
        .collapsed(collapsed);
    for row in demo_sidebar_rows(cx, &d.nav, d.spaces, &d.rows) {
        shell = shell.child(row);
    }
    shell
}

/// `DemoChat`: the demo exchange in a padded column.
pub(crate) fn demo_chat(lang: Lang) -> AnyElement {
    let d = demo(lang);
    let bubble = |text: &'static str| {
        Stack::row().justify(Justify::End).child(
            Box::new()
                .surface(Surface::Muted)
                .radius(Radius::Panel)
                .padding(Space::Md)
                .child(Typo::body(text)),
        )
    };
    Box::new()
        .padding(Space::Lg)
        .child(
            Stack::new()
                .gap(Space::Lg)
                .child(bubble(d.chat[0]))
                .child(Typo::body(d.chat[1]))
                .child(bubble(d.chat[2])),
        )
        .into_any_element()
}

/// The pane that stands for the browser sheet: the pane's surface with a page card, a toolbar
/// and the page's title.
pub(crate) fn browser_pane(lang: Lang, cx: &App) -> AnyElement {
    let d = demo(lang);
    let ds = Ds::get(cx);
    let toolbar = div()
        .flex()
        .items_center()
        .gap(ds.len(Length::SpaceSm))
        .h(ds.len(Length::TitlebarHeight))
        .px(ds.len(Length::SpaceMd))
        .border_b(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .child(Typo::caption(d.url).tone(Tone::Secondary));
    let page = div()
        .flex()
        .flex_col()
        .flex_auto()
        .min_h_0()
        .overflow_hidden()
        .rounded(ds.len(Length::RadiusPopover))
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .bg(ds.color(Color::SurfaceRaised))
        .child(toolbar)
        .child(
            div()
                .p(ds.len(Length::Space2xl))
                .child(Typo::new(Role::PanelTitle, d.tab_title)),
        );
    div()
        .flex()
        .flex_col()
        .flex_auto()
        .min_h_0()
        .p(ds.len(Length::SpaceSm))
        .rounded(ds.len(Length::ShellCardRadius))
        .bg(ds.color(Color::BrowserPaneBg))
        .child(page)
        .into_any_element()
}

/// The pane that stands for the file viewer: a card holding a file's title and text.
pub(crate) fn file_viewer(lang: Lang) -> AnyElement {
    let (file, meta, body) = lang.pick(
        (
            "Release notes.md",
            "Markdown · 4 KB",
            "Shortcut conflicts are listed by window. Each row names the two actions that share a key and the one that wins.",
        ),
        (
            "릴리스 노트.md",
            "마크다운 · 4KB",
            "단축키 충돌을 창별로 정리했습니다. 각 행에는 같은 키를 쓰는 두 동작과 우선하는 동작이 있습니다.",
        ),
    );
    ShellCard::new()
        .child(
            Box::new().padding(Space::Xxl).child(
                Stack::new()
                    .gap(Space::Md)
                    .child(
                        Stack::new()
                            .gap(Space::None)
                            .child(Typo::new(Role::PanelTitle, file))
                            .child(Typo::caption(meta).tone(Tone::Secondary)),
                    )
                    .child(Typo::body(body)),
            ),
        )
        .into_any_element()
}
