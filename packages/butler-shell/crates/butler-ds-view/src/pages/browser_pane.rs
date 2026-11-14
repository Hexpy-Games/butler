//! BrowserPane.showcase.tsx (+ fixtures `BrowserDemo`, `ConversationFrame`): the pane alone in a
//! conversation and in the standalone browser, and whole windows, flat and cards frame, with
//! Butler holding the tab. The sidebar, the chat and the page are stand-ins; the window is the
//! real shell. Butler's pointer (AgentPointer) is a later block and is not drawn.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::adaptive_shell::parts::ChromeFloatingToggle;
use butler_ds::ui::blocks::adaptive_shell::split::AdaptiveShellSplit;
use butler_ds::ui::blocks::adaptive_shell::{AdaptiveShell, ShellFrame, ShellWindow, SplitConfig};
use butler_ds::ui::blocks::browser_pane::PanePlacement;
use butler_ds::ui::blocks::page_card::PageCardHolder;
use butler_ds::ui::blocks::titlebar_shell::{LeadingSize, TitlebarShell};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::{IconButton, Pane, Tone};
use gpui::{
    AnyElement, App, ElementId, IntoElement as _, ParentElement as _, Styled as _, Window, div, px,
};

use super::Story;
use crate::browser_demo::sub;
use crate::browser_pane_demo::{PaneSpec, demo_pane};
use crate::copy::Lang;
use crate::standins_window::{demo, demo_chat, demo_sidebar, scaled_frame};

/// One window of `ConversationFrameDemo` / `StandaloneFrameDemo`.
#[derive(Clone, Copy)]
struct Frame {
    key: &'static str,
    size: (f32, f32),
    shell: ShellFrame,
    standalone: bool,
    sidebar_open: bool,
    pane: PaneSpec,
}

const CONVERSATION: Frame = Frame {
    key: "bp-conversation",
    size: (1440., 900.),
    shell: ShellFrame::Flat,
    standalone: false,
    sidebar_open: true,
    pane: PaneSpec::BUTLER,
};

const NO_BUTLER: PaneSpec = PaneSpec {
    placement: PanePlacement::Standalone,
    holder: PageCardHolder::None,
    band: None,
    agent: false,
    loading: None,
};

pub(super) fn stories() -> Vec<Story> {
    let mut all = first_stories();
    all.extend(more_stories());
    all
}

fn first_stories() -> Vec<Story> {
    vec![
        Story {
            // Butler controls the tab: the pane edge takes the riso inks on all four edges.
            name: "Controlled: Butler holds the tab (cards frame)",
            render: |l, w, c| {
                window(
                    Frame {
                        key: "bp-controlled",
                        shell: ShellFrame::Cards,
                        ..CONVERSATION
                    },
                    l,
                    w,
                    c,
                )
            },
        },
        Story {
            name: "Controlled: standalone browser (cards frame)",
            render: |l, w, c| {
                window(
                    Frame {
                        key: "bp-controlled-standalone",
                        shell: ShellFrame::Cards,
                        standalone: true,
                        pane: PaneSpec {
                            placement: PanePlacement::Standalone,
                            ..PaneSpec::BUTLER
                        },
                        ..CONVERSATION
                    },
                    l,
                    w,
                    c,
                )
            },
        },
        Story {
            name: "Conversation frame at 1440 (cards frame)",
            render: |l, w, c| {
                window(
                    Frame {
                        key: "bp-cards",
                        shell: ShellFrame::Cards,
                        ..CONVERSATION
                    },
                    l,
                    w,
                    c,
                )
            },
        },
        Story {
            // The approved layout: chat left (400px), the pane right, Butler holding the tab.
            name: "Conversation frame at 1440",
            render: |l, w, c| window(CONVERSATION, l, w, c),
        },
    ]
}

fn more_stories() -> Vec<Story> {
    vec![
        Story {
            name: "Conversation frame at 1100 (sidebar collapsed)",
            render: |l, w, c| {
                window(
                    Frame {
                        key: "bp-1100",
                        size: (1100., 800.),
                        sidebar_open: false,
                        ..CONVERSATION
                    },
                    l,
                    w,
                    c,
                )
            },
        },
        Story {
            name: "Standalone browser at 1440",
            render: |l, w, c| {
                window(
                    Frame {
                        key: "bp-standalone",
                        standalone: true,
                        pane: NO_BUTLER,
                        ..CONVERSATION
                    },
                    l,
                    w,
                    c,
                )
            },
        },
        Story {
            name: "Pane in a conversation",
            render: |l, w, c| pane(PanePlacement::Conversation, "bp-pane-conv", l, w, c),
        },
        Story {
            name: "Pane in the standalone browser",
            render: |l, w, c| pane(PanePlacement::Standalone, "bp-pane-solo", l, w, c),
        },
    ]
}

/// `Pane`: the pane alone, at a pane's height.
fn pane(
    placement: PanePlacement,
    id: &'static str,
    lang: Lang,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let spec = PaneSpec {
        placement,
        ..PaneSpec::BUTLER
    };
    div()
        .flex()
        .h(px(560.))
        .child(demo_pane(id, spec, lang, window, cx))
        .into_any_element()
}

fn title_row(lang: Lang, frame: &Frame, chat_width: f32) -> TitlebarShell {
    let d = demo(lang);
    let key = frame.key;
    if frame.standalone {
        // The standalone title names the conversation that owns the tab.
        let leading = Button::new(sub(key, "owner"))
            .size(Size::Xs)
            .variant(Variant::Ghost)
            .text(d.conversation);
        return TitlebarShell::new(sub(key, "title"), d.browser)
            .collapsed(!frame.sidebar_open)
            .drag_region()
            .leading_size(LeadingSize::Auto)
            .leading(leading);
    }
    let browsing = frame.pane.holder == PageCardHolder::Butler;
    let toggle = IconButton::new(sub(key, "browser"), d.hide_browser)
        .glyph(Icon::Globe2)
        .pane(Pane::Browser)
        .pressed(true)
        .tone(if browsing { Tone::Riso } else { Tone::Butler });
    let trailing = button::container(Size::IconSm)
        .child(
            IconButton::new(sub(key, "actions"), d.actions)
                .glyph(Icon::MoreHorizontal)
                .menu_trigger(),
        )
        .child(toggle)
        .child(IconButton::new(sub(key, "inspector"), d.inspector).glyph(Icon::PanelRight));
    TitlebarShell::new(sub(key, "title"), d.conversation)
        .collapsed(!frame.sidebar_open)
        .drag_region()
        .split_chat_width(Some(chat_width))
        .trailing(trailing)
}

/// A whole window: the sidebar, the title row and the chat | pane split (or the pane alone).
fn window(spec: Frame, lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let key = spec.key;
    let d = demo(lang);
    let width_state = window.use_keyed_state((ElementId::from(key), "width"), cx, |_, _| 400.0_f32);
    let chat_width = *width_state.read(cx);
    let pane = demo_pane(key, spec.pane, lang, window, cx);
    let workspace = if spec.standalone {
        pane
    } else {
        AdaptiveShellSplit::new(sub(key, "split"))
            .chat(demo_chat(lang))
            .pane(pane)
            .pane_open(true)
            .chat_width(chat_width)
            .on_chat_width_change(move |next, window, cx| {
                width_state.update(cx, |width, _| *width = next);
                window.refresh();
            })
            .resize_label(d.resize_chat)
            .resize_hint(d.drag_to_resize)
            .into_any_element()
    };
    let mut shell = AdaptiveShell::new(key, ShellWindow::new(spec.size.0, spec.size.1))
        .frame(spec.shell)
        .left_open(spec.sidebar_open)
        .panel_widths(304., 376.)
        .sidebar(demo_sidebar("bp-sidebar", lang, !spec.sidebar_open, cx))
        .title(title_row(lang, &spec, chat_width))
        .workspace(workspace);
    if !spec.standalone {
        shell = shell.split(SplitConfig::new(true).chat_width(chat_width));
    }
    if !spec.sidebar_open {
        shell = shell.chrome(ChromeFloatingToggle::new(
            sub(key, "chrome"),
            IconButton::new(sub(key, "show-sidebar"), d.show_sidebar).glyph(Icon::PanelLeft),
        ));
    }
    let _ = icon(Icon::PanelLeft, IconSize::Md, Ds::get(cx));
    scaled_frame(
        (ElementId::from(key), "frame"),
        spec.size,
        shell.into_any_element(),
        window,
        cx,
    )
}
