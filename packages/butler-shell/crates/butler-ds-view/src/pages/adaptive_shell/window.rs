//! The content of the demo windows: the title row, the view under it and the settings stand-in.
use butler_ds::tokens::{Color, Length};
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::adaptive_shell::ShellFrame;
use butler_ds::ui::blocks::adaptive_shell::parts::ShellCard;
use butler_ds::ui::blocks::adaptive_shell::split::AdaptiveShellSplit;
use butler_ds::ui::blocks::conversation_shell::{ConversationScroll, ConversationShell};
use butler_ds::ui::blocks::titlebar_shell::{LeadingSize, TitlebarShell};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon_button::{IconButton, Pane, Tone};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::{Role, Tone as TextTone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, Window, div, px};

use crate::copy::Lang;
use crate::standins_window::{browser_pane, demo, demo_chat};

use super::{Content, Spec, View, glyph};

/// The conversation title row of the demo windows: the conversation, ⋯, the browser toggle and
/// the inspector toggle (`ConversationFrameDemo`, `DemoTitle`).
pub(super) fn title_row(
    lang: Lang,
    spec: &Spec,
    pane_open: bool,
    collapsed: bool,
) -> TitlebarShell {
    let d = demo(lang);
    if spec.view == View::Hub {
        let leading = Button::new("frame-hub-leading")
            .size(Size::Xs)
            .variant(Variant::Ghost)
            .text(d.conversation);
        return TitlebarShell::new("frame-title", d.browser)
            .collapsed(collapsed)
            .drag_region()
            .leading_size(LeadingSize::Auto)
            .leading(leading);
    }
    let browsing = spec.frame == ShellFrame::Flat
        && spec.view == View::Browser
        && spec.content == Content::Chat
        && !spec.wallpaper;
    let browser = IconButton::new(
        "frame-browser",
        if pane_open { d.hide_browser } else { d.browser },
    )
    .glyph(Icon::Globe2)
    .pane(Pane::Browser)
    .pressed(pane_open)
    .tone(match (browsing, pane_open) {
        (true, _) => Tone::Riso,
        (_, true) => Tone::Butler,
        _ => Tone::Default,
    });
    let browser = if browsing && !pane_open {
        browser.indicator()
    } else {
        browser
    };
    let trailing = button::container(Size::IconSm)
        .child(glyph("frame-actions", d.actions, Icon::MoreHorizontal).menu_trigger())
        .child(browser)
        .child(glyph("frame-inspector", d.inspector, Icon::PanelRight));
    TitlebarShell::new("frame-title", d.conversation)
        .collapsed(collapsed)
        .drag_region()
        .trailing(trailing)
}

/// The window's content under the title row.
pub(super) fn body(
    lang: Lang,
    spec: &Spec,
    pane_open: bool,
    chat_width: f32,
    set_width: impl Fn(f32, &mut Window, &mut App) + 'static,
    cx: &App,
) -> AnyElement {
    let d = demo(lang);
    match spec.view {
        View::Browser | View::File => AdaptiveShellSplit::new("frame-split")
            .chat(demo_chat(lang))
            .pane(if spec.view == View::File {
                crate::standins_window::file_viewer(lang)
            } else {
                browser_pane(lang, cx)
            })
            .pane_open(pane_open)
            .chat_width(chat_width)
            .on_chat_width_change(set_width)
            .resize_label(d.resize_chat)
            .resize_hint(d.drag_to_resize)
            .into_any_element(),
        View::Hub => browser_pane(lang, cx),
        View::Settings => settings(lang, cx),
        View::Chat => ShellCard::new()
            .child(conversation(lang, spec, cx))
            .into_any_element(),
    }
}

/// `DemoConversation`: the chat, a long conversation or the empty new chat in a conversation shell.
fn conversation(lang: Lang, spec: &Spec, cx: &App) -> AnyElement {
    if spec.content == Content::Chat && !spec.wallpaper {
        return demo_chat(lang);
    }
    let ds = Ds::get(cx);
    let scroll = match spec.content {
        Content::Long => {
            ConversationScroll::new("frame-long").children((0..12).map(|_| demo_chat(lang)))
        }
        _ => ConversationScroll::new("frame-chat").child(demo_chat(lang)),
    };
    let mut shell = ConversationShell::new("frame-conversation", 160.).child(scroll);
    if spec.wallpaper {
        shell = shell.background(div().size_full().opacity(0.18).bg(gpui::linear_gradient(
            135.,
            gpui::linear_color_stop(ds.color(Color::ButlerInkBlue), 0.),
            gpui::linear_color_stop(ds.color(Color::ButlerInkPink), 1.),
        )));
    }
    shell.into_any_element()
}

/// The settings screen: the navigation on the shell, the detail pane as the card (stand-in).
fn settings(lang: Lang, cx: &App) -> AnyElement {
    let (nav, appearance, description) = lang.pick(
        (
            ["General", "Appearance"],
            "Appearance",
            "Theme and how the app looks.",
        ),
        (
            ["일반", "모양"],
            "모양",
            "앱의 테마와 화면 표시 방식을 설정합니다.",
        ),
    );
    let ds = Ds::get(cx);
    let nav_col = Stack::new().gap(Space::Xs).children(nav.map(Typo::label));
    ShellCard::new()
        .child(
            div()
                .flex()
                .size_full()
                .child(div().w(px(220.)).p(ds.len(Length::SpaceLg)).child(nav_col))
                .child(
                    div().flex_auto().p(ds.len(Length::Space2xl)).child(
                        Stack::new()
                            .gap(Space::Sm)
                            .child(Typo::new(Role::PanelTitle, appearance))
                            .child(Typo::caption(description).tone(TextTone::Secondary)),
                    ),
                ),
        )
        .into_any_element()
}
