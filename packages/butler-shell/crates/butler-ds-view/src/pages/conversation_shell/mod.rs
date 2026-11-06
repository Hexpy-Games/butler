//! ConversationShell.showcase.tsx (+ `.demo.tsx`, `.asideDemo.tsx`). The message rows, the
//! composer, the tab rail, the prompt list, the wallpaper and the session sections are
//! stand-ins for blocks of later batches.
use butler_ds::tokens::{Color, Length};
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::conversation_shell::{
    AsideLayout, ConversationScroll, ConversationScrollToBottomButton, ConversationShell,
    MessageListSurface,
};
use butler_ds::ui::blocks::list_row::ListRow;
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::card::{Card, CardPadding};
use butler_ds::ui::context::Ds;
use butler_ds::ui::convert;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::{Role, Tone, Typo};
use gpui::{
    AnyElement, App, ElementId, IntoElement as _, ParentElement as _, SharedString, Styled as _,
    Window, div, px,
};

mod copy;

use copy::{Copy, copy};

use super::Story;
use crate::copy::Lang;
use crate::standins_shell::message_row;
use crate::standins_window::{browser_pane, scaled_frame};

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Messages",
            render: |l, w, c| messages(l, false, w, c),
        },
        Story {
            name: "Unread below",
            render: |l, w, c| messages(l, true, w, c),
        },
        Story {
            name: "Background: new chat, then messages",
            render: |l, w, c| background(l, false, w, c),
        },
        Story {
            name: "Background behind messages",
            render: |l, w, c| background(l, true, w, c),
        },
        Story {
            name: "Tab rail beside the messages",
            render: rail,
        },
        Story {
            name: "Aside docked: margin cards",
            render: aside_docked,
        },
        Story {
            name: "Aside docked: open and close",
            render: aside_toggle_docked,
        },
        Story {
            name: "Aside floating",
            render: aside_floating,
        },
        Story {
            name: "Aside floating beside the browser pane",
            render: aside_beside_browser,
        },
    ]
}

/// `.frame`: the viewer's bordered, clipped frame.
fn frame(height: f32, content: AnyElement, cx: &App) -> AnyElement {
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

fn rows(turns: &[(bool, &'static str)], cx: &App) -> Vec<AnyElement> {
    turns
        .iter()
        .map(|(user, body)| message_row(*user, body, cx))
        .collect()
}

fn messages(lang: Lang, jump: bool, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let id = if jump {
        "conversation-unread"
    } else {
        "conversation-messages"
    };
    let mut shell = ConversationShell::new(id, 24.).child(
        ConversationScroll::new((ElementId::from(id), "scroll"))
            .child(MessageListSurface::new().children(rows(&c.turns, cx))),
    );
    if jump {
        shell = shell.child(
            ConversationScrollToBottomButton::new("conversation-jump", c.latest)
                .unread(true)
                .text(c.unread),
        );
    }
    frame(420., shell.into_any_element(), cx) // DS: ConversationShell.showcase.module.css:3
}

/// The wallpaper's place: a still gradient stands in for the live module (a block of a later batch).
fn backdrop(cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let (from, to) = (
        ds.color(Color::ButlerInkBlue),
        ds.color(Color::ButlerInkPink),
    );
    div()
        .size_full()
        .opacity(0.18)
        .bg(gpui::linear_gradient(
            135.,
            gpui::linear_color_stop(from, 0.),
            gpui::linear_color_stop(to, 1.),
        ))
        .into_any_element()
}

/// The new-chat prompt list: the title over two suggestion cards (PromptSuggestionList stand-in).
fn prompt_list(c: &Copy, cx: &App) -> AnyElement {
    let cards = c
        .suggestions
        .iter()
        .enumerate()
        .map(|(index, (title, text))| {
            Card::new(SharedString::from(format!("suggestion-{index}")))
                .padding(CardPadding::Md)
                .interactive()
                .child(
                    Stack::new()
                        .gap(Space::Xs)
                        .child(Typo::new(Role::Label, *title))
                        .child(Typo::caption(*text).tone(Tone::Secondary)),
                )
        });
    let ds = Ds::get(cx);
    div()
        .w(gpui::relative(0.86))
        .max_w(px(760.))
        .mx_auto()
        .pt(ds.len(Length::TitlebarSafeAreaTop))
        .child(
            Stack::new()
                .gap(Space::Lg)
                .child(Typo::new(Role::H1, c.title))
                .child(Stack::new().gap(Space::Md).children(cards)),
        )
        .into_any_element()
}

fn background(lang: Lang, with_messages: bool, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let id: &'static str = if with_messages {
        "background-messages"
    } else {
        "background-new"
    };
    let sent = window.use_keyed_state(id, cx, move |_, _| with_messages);
    let showing = *sent.read(cx);
    let body: AnyElement = if showing {
        let turns = [(true, c.suggestions[0].0), (false, c.reply)];
        ConversationScroll::new((ElementId::from(id), "scroll"))
            .child(MessageListSurface::new().children(rows(&turns, cx)))
            .into_any_element()
    } else {
        ConversationScroll::new((ElementId::from(id), "scroll"))
            .masked(false)
            .scrollable(false)
            .child(prompt_list(&c, cx))
            .into_any_element()
    };
    let shell = ConversationShell::new(id, 24.)
        .background(backdrop(cx))
        .child(body);
    let ds = Ds::get(cx);
    div()
        .relative()
        .h(px(560.)) // DS: ConversationShell.showcase.module.css:53
        .overflow_hidden()
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .rounded(ds.len(Length::RadiusPanel))
        .child(shell)
        .into_any_element()
}

/// The tab rail's place: a card of tabs in the right margin (TabRail is a block of a later batch).
fn tab_rail(cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    div()
        .absolute()
        .top(ds.len(Length::SpaceLg))
        .right(ds.len(Length::TabRailInset))
        .w(ds.len(Length::TabRailWidth))
        .p(ds.len(Length::SpaceSm))
        .rounded(ds.len(Length::RadiusPopover))
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .bg(ds.color(Color::SurfaceRaised))
        .child(Typo::label("Office chairs"))
        .into_any_element()
}

fn rail(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let shell = ConversationShell::new("conversation-rail", 24.)
        .rail(tab_rail(cx), true, Some("view".into()))
        .child(
            ConversationScroll::new("conversation-rail-scroll")
                .child(MessageListSurface::new().children(rows(&c.turns[..2], cx))),
        );
    frame(420., shell.into_any_element(), cx)
}

/// `SessionDetails`: the sections, one flat Card each while docked, bare on glass while floating.
fn session_details(_c: &Copy, layout: AsideLayout, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let sections: Vec<AnyElement> = ["asks", "task", "results", "files", "env"]
        .iter()
        .enumerate()
        .map(|(index, name)| {
            let glyph = icon(Icon::FileText, IconSize::Sm, ds).into_any_element();
            let title =
                Typo::new(Role::PanelSectionTitle, format!("{name} {index}")).tone(Tone::Primary);
            Stack::new()
                .gap(Space::Sm)
                .child(title)
                .child(
                    ListRow::new("preview-14.md")
                        .icon(glyph)
                        .meta("Approval · 2 min ago"),
                )
                .into_any_element()
        })
        .collect();
    match layout {
        AsideLayout::Docked => Stack::new()
            .gap(Space::Md)
            .children(
                sections
                    .into_iter()
                    .map(|s| Card::new("details-card").padding(CardPadding::Sm).child(s)),
            )
            .into_any_element(),
        AsideLayout::Floating => Stack::new()
            .gap(Space::Xl)
            .children(sections)
            .into_any_element(),
    }
}

/// `AsideConversation`: a conversation with the session details in its aside; the stage's width
/// decides docked or floating.
fn aside_conversation(
    lang: Lang,
    id: &'static str,
    (open, float_open): (bool, bool),
    cx: &App,
) -> AnyElement {
    let c = copy(lang);
    let mut shell = ConversationShell::new(id, 72.)
        .aside_float_open(float_open)
        .child(
            ConversationScroll::new((ElementId::from(id), "scroll"))
                .child(MessageListSurface::new().children(rows(&c.chat, cx))),
        )
        .child(Composer(c.prompt));
    if open {
        shell = shell.aside(move |layout| AsideBody { layout, lang }.into_any_element());
    }
    shell.into_any_element()
}

/// The composer card of the session stories, floating at the bottom edge (ComposerCard stand-in).
#[derive(gpui::IntoElement)]
struct Composer(&'static str);

impl gpui::RenderOnce for Composer {
    fn render(self, _: &mut Window, cx: &mut App) -> impl gpui::IntoElement {
        composer(self.0, cx)
    }
}

fn composer(prompt: &'static str, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    // The composer shares the message column's width and place.
    let column = butler_ds::ui::blocks::scope::conversation(cx).unwrap_or_default();
    let el = div().absolute().bottom(ds.len(Length::SpaceLg));
    let el = if column.column_width > 0. {
        el.left(px(column.column_left)).w(px(column.column_width))
    } else {
        el.left_0()
            .right_0()
            .px(ds.len(Length::AdaptiveComposerInset))
    };
    el.child(
        div()
            .p(ds.len(Length::SpaceMd))
            .rounded(ds.len(Length::RadiusComposer))
            .border(ds.len(Length::BorderHairline))
            .border_color(ds.color(Color::ComposerGlassBorder))
            .bg(ds.color(Color::ComposerGlassBg))
            .child(Typo::body(prompt).tone(Tone::Secondary)),
    )
    .into_any_element()
}

#[derive(gpui::IntoElement)]
struct AsideBody {
    layout: AsideLayout,
    lang: Lang,
}

impl gpui::RenderOnce for AsideBody {
    fn render(self, _: &mut Window, cx: &mut App) -> impl gpui::IntoElement {
        session_details(&copy(self.lang), self.layout, cx)
    }
}

/// `.asideStage`: the chat card the aside lives in.
fn aside_stage(content: AnyElement, narrow: bool, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let stage = div()
        .relative()
        .overflow_hidden()
        .size_full()
        .bg(convert::gradient(
            ds.tokens()
                .gradient(butler_ds::tokens::GradientToken::ConversationBg),
        ))
        .child(content);
    if narrow {
        div()
            .max_w(px(640.)) // DS: ConversationShell.showcase.module.css:29
            .h(px(600.))
            .border(ds.len(Length::BorderHairline))
            .border_color(ds.color(Color::Line))
            .rounded(ds.len(Length::RadiusPopover))
            .overflow_hidden()
            .child(stage)
            .into_any_element()
    } else {
        stage.into_any_element()
    }
}

fn aside_docked(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let content = aside_stage(
        aside_conversation(lang, "aside-docked", (true, true), cx),
        false,
        cx,
    );
    scaled_frame("aside-docked-frame", (1100., 620.), content, window, cx)
}

/// A toggle button over a stage: pressed while the aside is open.
fn toggled(
    lang: Lang,
    key: &'static str,
    window: &mut Window,
    cx: &mut App,
    stage: impl FnOnce(bool, &mut Window, &mut App) -> AnyElement,
) -> AnyElement {
    let state = window.use_keyed_state(key, cx, |_, _| true);
    let open = *state.read(cx);
    let toggle = Button::new((ElementId::from(key), "toggle"))
        .size(Size::Sm)
        .variant(Variant::Secondary)
        .text(copy(lang).label)
        .on_click(move |_, window, cx| {
            state.update(cx, |open, cx| {
                *open = !*open;
                cx.notify();
            });
            window.refresh();
        });
    let body = stage(open, window, cx);
    Stack::new()
        .gap(Space::Sm)
        .child(button::container(Size::Sm).child(toggle))
        .child(body)
        .into_any_element()
}

fn aside_toggle_docked(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    toggled(
        lang,
        "aside-toggle-docked",
        window,
        cx,
        move |open, window, cx| {
            let content = aside_stage(
                aside_conversation(lang, "aside-open-close", (open, true), cx),
                false,
                cx,
            );
            scaled_frame("aside-open-close-frame", (1100., 620.), content, window, cx)
        },
    )
}

fn aside_floating(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    toggled(
        lang,
        "aside-toggle-floating",
        window,
        cx,
        move |open, _, cx| {
            aside_stage(
                aside_conversation(lang, "aside-floating", (true, open), cx),
                true,
                cx,
            )
        },
    )
}

/// A 1180px window with an open browser pane: the chat card is narrow, so the aside floats over it.
fn aside_beside_browser(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let ds = Ds::get(cx);
    let chat = div()
        .relative()
        .flex_basis(gpui::relative(0.))
        .flex_grow(2.)
        .min_w_0()
        .overflow_hidden()
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .rounded(ds.len(Length::RadiusPopover))
        .child(aside_stage(
            aside_conversation(lang, "aside-browser", (true, true), cx),
            false,
            cx,
        ));
    let pane = div()
        .flex_basis(gpui::relative(0.))
        .flex_grow(3.)
        .min_w_0()
        .flex()
        .child(browser_pane(lang, cx));
    let grid = div()
        .flex()
        .size_full()
        .p(ds.len(Length::SpaceSm))
        .gap(ds.len(Length::SpaceSm))
        .bg(ds.color(Color::ShellBg))
        .child(chat)
        .child(pane);
    scaled_frame(
        "aside-browser-frame",
        (1180., 620.),
        grid.into_any_element(),
        window,
        cx,
    )
}
