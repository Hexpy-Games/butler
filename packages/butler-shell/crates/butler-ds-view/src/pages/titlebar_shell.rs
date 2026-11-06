//! TitlebarShell.showcase.tsx (+ fixtures `SplitTitlebarDemo`, `PaneTogglesDemo`). The window of
//! the split stories is the AdaptiveShell cards frame with the demo sidebar and chat.
use butler_ds::tokens::{Color, Length};
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::adaptive_shell::parts::ChromeFloatingToggle;
use butler_ds::ui::blocks::adaptive_shell::split::AdaptiveShellSplit;
use butler_ds::ui::blocks::adaptive_shell::{AdaptiveShell, ShellFrame, ShellWindow, SplitConfig};
use butler_ds::ui::blocks::titlebar_shell::{LeadingSize, TitlebarShell};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::{IconButton, Pane, Tone};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::typo::{Tone as TextTone, Typo};
use gpui::{
    AnyElement, App, ElementId, IntoElement as _, ParentElement as _, SharedString, Styled as _,
    Window, div,
};

use super::Story;
use crate::copy::Lang;
use crate::standins_window::{
    browser_pane, demo, demo_chat, demo_sidebar, file_viewer, scaled_frame,
};

type Toggle = std::rc::Rc<dyn Fn(&mut Window, &mut App)>;

struct Copy {
    title: &'static str,
    project: &'static str,
    branch: &'static str,
    show_left: &'static str,
    show_right: &'static str,
    menu: &'static str,
    minimize: &'static str,
    maximize: &'static str,
    close: &'static str,
    browser: &'static str,
    conversation: &'static str,
    open_conversation: &'static str,
    browser_active: &'static str,
    nested: &'static str,
    back: &'static str,
    session_info: &'static str,
    session_info_pending: &'static str,
    show_browser: &'static str,
    hide_browser: &'static str,
    viewer: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            title: "Token page review",
            project: "butler",
            branch: "ui/ds-viewer-complete",
            show_left: "Show left panel",
            show_right: "Show right panel",
            menu: "Session actions",
            minimize: "Minimize window",
            maximize: "Maximize window",
            close: "Close window",
            browser: "Browser",
            conversation: "Office chair order",
            open_conversation: "Open conversation",
            browser_active: "Butler is browsing",
            nested: "Travel",
            back: "Back to Scraps",
            session_info: "Session info",
            session_info_pending: "Session info · requests waiting for your answer",
            show_browser: "Show browser",
            hide_browser: "Hide browser",
            viewer: "File viewer",
        },
        Copy {
            title: "토큰 페이지 검토",
            project: "butler",
            branch: "ui/ds-viewer-complete",
            show_left: "왼쪽 패널 보기",
            show_right: "오른쪽 패널 보기",
            menu: "세션 작업",
            minimize: "창 최소화",
            maximize: "창 최대화",
            close: "창 닫기",
            browser: "브라우저",
            conversation: "사무용 의자 주문",
            open_conversation: "대화 열기",
            browser_active: "버틀러가 브라우저 사용 중",
            nested: "여행",
            back: "스크랩으로 돌아가기",
            session_info: "세션 정보",
            session_info_pending: "세션 정보 · 답을 기다리는 요청 있음",
            show_browser: "브라우저 열기",
            hide_browser: "브라우저 닫기",
            viewer: "파일 보기",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    let names = [
        "Auto-sized leading control (sidebar open)",
        "Auto-sized leading control (sidebar collapsed)",
        "Collapsed sidebar (macOS)",
        "Windows controls",
        "Nested screen: back button",
        "Title actions and chat trailing: session info without and with the dot",
        "Session info open: the pressed toggle without and with the dot",
        "Pane toggles: closed, then 세션 정보, the file viewer and the browser open (each fills with its pane's surface)",
        "File viewer open: its toggle fills with the viewer card's surface",
        "Browser split closed: chat trailing before the browser toggle",
        "Browser split open: the chat group spans the chat card (drag the divider)",
        "Browser split open, sidebar collapsed",
    ];
    let renders: [fn(Lang, &mut Window, &mut App) -> AnyElement; 12] = [
        |l, w, c| leading_story(l, false, w, c),
        |l, w, c| leading_story(l, true, w, c),
        |l, _, c| titlebar_story(l, false, c),
        |l, _, c| titlebar_story(l, true, c),
        nested,
        |l, _, c| grouped_story(l, false, c),
        |l, _, c| grouped_story(l, true, c),
        pane_toggles,
        |l, w, c| split_window(l, (true, true, "viewer"), w, c),
        |l, w, c| split_window(l, (false, true, "browser"), w, c),
        |l, w, c| split_window(l, (true, true, "browser"), w, c),
        |l, w, c| split_window(l, (true, false, "browser"), w, c),
    ];
    names
        .into_iter()
        .zip(renders)
        .map(|(name, render)| Story { name, render })
        .collect()
}

/// `.fixture`: the bar in a bordered, clipped box on the title surface.
fn fixture(bar: impl gpui::IntoElement, shell_surface: bool, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let bg = if shell_surface {
        Color::ShellBg
    } else {
        Color::TitlebarBg
    };
    div()
        .relative()
        .min_h(ds.len(Length::TitlebarHeight))
        .overflow_hidden()
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .rounded(ds.len(Length::RadiusPanel))
        .bg(ds.color(bg))
        .child(bar)
        .into_any_element()
}

fn leading_story(lang: Lang, collapsed: bool, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    let leading = Button::new("titlebar-conversation")
        .size(Size::Xs)
        .variant(Variant::Ghost)
        .icon_start(icon(Icon::MessageSquare, IconSize::Sm, ds))
        .text(c.conversation);
    let _ = c.open_conversation;
    let trailing = button::container(Size::IconSm).child(
        IconButton::new("titlebar-browser-active", c.browser_active)
            .glyph(Icon::Globe2)
            .tone(Tone::Riso)
            .indicator()
            .pressed(false),
    );
    let mut bar = TitlebarShell::new("titlebar-leading", c.browser)
        .collapsed(collapsed)
        .drag_region()
        .leading_size(LeadingSize::Auto)
        .leading(leading)
        .trailing(trailing);
    if !collapsed {
        bar = bar.start_padding(18.); // DS: TitlebarShell.module.css:5
    }
    fixture(bar, false, cx)
}

fn subtitle(c: &Copy, cx: &App) -> AnyElement {
    Stack::row()
        .cross(Cross::Center)
        .gap(Space::Xs)
        .child(Typo::caption(c.project).tone(TextTone::Secondary))
        .child(glyph_sm(Icon::GitBranch, cx))
        .child(Typo::caption(c.branch).tone(TextTone::Secondary))
        .into_any_element()
}

fn glyph_sm(icon_glyph: Icon, cx: &App) -> AnyElement {
    icon(icon_glyph, IconSize::Sm, Ds::get(cx)).into_any_element()
}

fn titlebar_story(lang: Lang, windows: bool, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let trailing = button::container(Size::IconSm)
        .child(
            IconButton::new("titlebar-menu", c.menu)
                .glyph(Icon::MoreHorizontal)
                .menu_trigger(),
        )
        .child(IconButton::new("titlebar-right", c.show_right).glyph(Icon::PanelRight));
    let mut bar = TitlebarShell::new("titlebar-macos", c.title)
        .start_padding(18.) // DS: TitlebarShell.module.css:5
        .collapsed(true)
        .drag_region()
        .leading(IconButton::new("titlebar-left", c.show_left).glyph(Icon::PanelLeft))
        .subtitle(subtitle(&c, cx))
        .trailing(trailing);
    if windows {
        bar = bar.window_controls(
            button::container(Size::IconSm)
                .child(IconButton::new("titlebar-min", c.minimize).glyph(Icon::Minus))
                .child(IconButton::new("titlebar-max", c.maximize).glyph(Icon::Square))
                .child(IconButton::new("titlebar-close", c.close).glyph(Icon::X)),
        );
    }
    fixture(bar, false, cx)
}

fn nested(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let bar = TitlebarShell::new("titlebar-nested", c.nested)
        .start_padding(18.) // DS: TitlebarShell.module.css:5
        .drag_region()
        .back(c.back, |_, _, _| {});
    fixture(bar, false, cx)
}

/// `SessionInfoToggle`: the attention dot while a request waits, named in the label.
fn session_info_toggle(id: SharedString, c: &Copy, pending: bool, open: bool) -> IconButton {
    let label = if pending {
        c.session_info_pending
    } else {
        c.session_info
    };
    let button = IconButton::new(id, label)
        .glyph(Icon::AppleReminder)
        .pane(Pane::Aside)
        .pressed(open)
        .tone(if open { Tone::Butler } else { Tone::Default });
    if pending { button.indicator() } else { button }
}

fn browser_toggle(id: SharedString, c: &Copy, open: bool, on_toggle: Option<Toggle>) -> IconButton {
    let button = IconButton::new(id, if open { c.hide_browser } else { c.show_browser })
        .glyph(Icon::Globe2)
        .pane(Pane::Browser)
        .pressed(open)
        .tone(if open { Tone::Butler } else { Tone::Default });
    match on_toggle {
        Some(toggle) => button.on_click(move |_, window, cx| toggle(window, cx)),
        None => button,
    }
}

fn viewer_toggle(id: SharedString, c: &Copy, open: bool, on_toggle: Option<Toggle>) -> IconButton {
    let button = IconButton::new(id, c.viewer)
        .glyph(Icon::FileText)
        .pane(Pane::Viewer)
        .pressed(open)
        .tone(if open { Tone::Butler } else { Tone::Default });
    match on_toggle {
        Some(toggle) => button.on_click(move |_, window, cx| toggle(window, cx)),
        None => button,
    }
}

/// Title, the workspace subtitle and the menu after them, as the conversation titlebar passes them.
fn conversation_title(id: &'static str, c: &Copy, cx: &App) -> TitlebarShell {
    TitlebarShell::new(id, c.title)
        .title_actions(
            IconButton::new(format!("{id}-menu"), c.menu)
                .glyph(Icon::MoreHorizontal)
                .menu_trigger(),
        )
        .subtitle(subtitle(c, cx))
}

/// What a grouped bar shows: the attention dot, the pressed 세션 정보 toggle, whether the viewer's
/// toggle is there and which pane's toggle is pressed.
#[derive(Clone, Copy)]
struct Grouped {
    pending: bool,
    open: bool,
    viewer: bool,
    pane: Option<&'static str>,
}

/// `GroupedTitlebar`: `[title subtitle ⋯ ······ 세션 정보][browser]`.
fn grouped_bar(id: &'static str, c: &Copy, opts: Grouped, cx: &App) -> TitlebarShell {
    let mut end = button::container(Size::IconSm);
    if opts.viewer {
        end = end.child(viewer_toggle(
            format!("{id}-viewer").into(),
            c,
            opts.pane == Some("viewer"),
            None,
        ));
    }
    end = end.child(browser_toggle(
        format!("{id}-browser").into(),
        c,
        opts.pane == Some("browser"),
        None,
    ));
    conversation_title(id, c, cx)
        .start_padding(18.) // DS: TitlebarShell.module.css:5
        .drag_region()
        .chat_trailing(button::container(Size::IconSm).child(session_info_toggle(
            format!("{id}-info").into(),
            c,
            opts.pending,
            opts.open,
        )))
        .trailing(end)
}

fn grouped_story(lang: Lang, open: bool, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let opts = |pending| Grouped {
        pending,
        open,
        viewer: false,
        pane: None,
    };
    Stack::new()
        .gap(Space::Sm)
        .child(fixture(
            grouped_bar("grouped-calm", &c, opts(false), cx),
            false,
            cx,
        ))
        .child(fixture(
            grouped_bar("grouped-pending", &c, opts(true), cx),
            false,
            cx,
        ))
        .into_any_element()
}

fn pane_toggles(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let rows = [
        ("toggles-closed", false, false, None),
        ("toggles-aside", true, true, None),
        ("toggles-viewer", false, false, Some("viewer")),
        ("toggles-browser", false, false, Some("browser")),
    ];
    let mut column = Stack::new().gap(Space::Sm);
    for (id, pending, open, pane) in rows {
        let opts = Grouped {
            pending,
            open,
            viewer: true,
            pane,
        };
        column = column.child(fixture(grouped_bar(id, &c, opts, cx), true, cx));
    }
    column.into_any_element()
}

/// A boolean held in the page's state, as the React stories' `useState`.
fn flag(id: &'static str, initial: bool, window: &mut Window, cx: &mut App) -> (bool, Toggle) {
    let state = window.use_keyed_state(id, cx, move |_, _| initial);
    let on = *state.read(cx);
    (
        on,
        std::rc::Rc::new(move |window: &mut Window, cx: &mut App| {
            state.update(cx, |on, cx| {
                *on = !*on;
                cx.notify();
            });
            window.refresh();
        }),
    )
}

/// The title row of the split window: the session toggle before the pane toggles; while the pane
/// is open the chat group spans the chat card (`split_chat_width`).
fn split_title(
    c: &Copy,
    (viewer, pane_open, sidebar_open): (bool, bool, bool),
    (toggle, split_width): (&Toggle, Option<f32>),
    cx: &App,
) -> TitlebarShell {
    let on_viewer: Option<Toggle> = viewer.then(|| toggle.clone());
    let on_browser: Option<Toggle> = (!viewer).then(|| toggle.clone());
    let end = button::container(Size::IconSm);
    let end = if viewer {
        end.child(viewer_toggle(
            "split-viewer-toggle".into(),
            c,
            pane_open,
            on_viewer,
        ))
    } else {
        end
    };
    let browser = browser_toggle(
        "split-browser-toggle".into(),
        c,
        !viewer && pane_open,
        on_browser,
    );
    let trailing = end.child(super::anchored(
        browser.into_any_element(),
        "split-browser-toggle",
    ));
    conversation_title("split-title", c, cx)
        .collapsed(!sidebar_open)
        .drag_region()
        .chat_trailing(button::container(Size::IconSm).child(session_info_toggle(
            "split-info".into(),
            c,
            true,
            false,
        )))
        .trailing(trailing)
        .split_chat_width(split_width)
}

/// `SplitWindowDemo`: a whole window (cards frame) with the split. The browser (or viewer)
/// toggle opens and closes the pane; the divider drags. `kind` is the pane in the right slot.
pub(super) fn split_window(
    lang: Lang,
    (pane_initial, sidebar_open, kind): (bool, bool, &'static str),
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let c = copy(lang);
    let d = demo(lang);
    let key: &'static str = match (kind, sidebar_open, pane_initial) {
        ("viewer", ..) => "split-viewer",
        (_, false, _) => "split-collapsed",
        (_, _, false) => "split-closed",
        _ => "split-open",
    };
    let (pane_open, toggle) = flag(key, pane_initial, window, cx);
    let width = window.use_keyed_state((ElementId::from(key), "width"), cx, |_, _| 400_f32);
    let chat_width = *width.read(cx);
    let (win_width, win_height) = crate::app::logical_viewport(window, cx);
    let shell_window = ShellWindow::new(win_width, win_height);
    let viewer = kind == "viewer";
    let title = split_title(
        &c,
        (viewer, pane_open, sidebar_open),
        (&toggle, pane_open.then_some(chat_width)),
        cx,
    );
    let chrome = (!sidebar_open).then(|| {
        ChromeFloatingToggle::new(
            "split-chrome",
            IconButton::new("split-show-sidebar", d.show_sidebar).glyph(Icon::PanelLeft),
        )
    });
    let pane = if viewer {
        file_viewer(lang)
    } else {
        browser_pane(lang, cx)
    };
    let split = AdaptiveShellSplit::new("split")
        .chat(demo_chat(lang))
        .pane(pane)
        .pane_open(pane_open)
        .chat_width(chat_width)
        .on_chat_width_change(move |next, window, cx| {
            width.update(cx, |width, _| *width = next);
            window.refresh();
        })
        .resize_label(d.resize_chat)
        .resize_hint(d.drag_to_resize);
    let mut shell = AdaptiveShell::new(key, shell_window)
        .frame(ShellFrame::Cards)
        .left_open(sidebar_open)
        .panel_widths(304., 376.)
        .split(SplitConfig::new(pane_open).chat_width(chat_width))
        .sidebar(demo_sidebar("split-sidebar", lang, !sidebar_open, cx))
        .title(title)
        .workspace(split);
    if let Some(chrome) = chrome {
        shell = shell.chrome(chrome);
    }
    scaled_frame(
        (ElementId::from(key), "frame"),
        (1440., 420.),
        shell.into_any_element(),
        window,
        cx,
    )
}
