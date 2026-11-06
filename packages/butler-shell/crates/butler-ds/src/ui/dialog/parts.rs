//! DialogHeader, DialogFooter, DialogTitle and DialogDescription (Dialog.module.css `.header`,
//! `.footer`, `.title`, `.description`). The Dialog tells them its layout and close room through
//! the [`strut::DialogFrame`] they are laid out in.
use std::rc::Rc;

use gpui::{
    AnyElement, App, FontWeight, IntoElement, ParentElement, RenderOnce, SharedString, Styled as _,
    Window, div, px,
};

use crate::tokens::{Color, Length, Number};
use crate::ui::button::{Button, Variant};
use crate::ui::context::Ds;
use crate::ui::strut::{self, DialogFrame};

/// Outside a Dialog: the plain flow layout, no close button.
const OUTSIDE: DialogFrame = DialogFrame {
    scroll_body: false,
    close_room: 0.,
    in_header: false,
};

fn frame(cx: &App) -> DialogFrame {
    strut::dialog(cx).unwrap_or(OUTSIDE)
}

/// A grid of title and description: `gap: --space-2`, inset `--space-6` at its end. A title-only
/// header followed by a footer is a confirmation: never shorter than a title, a gap and one line
/// of body, with its title centred.
#[derive(IntoElement, Default)]
pub struct DialogHeader {
    confirmation: bool,
    children: Vec<AnyElement>,
}

impl DialogHeader {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set by the content when a footer follows this header (`.header:has(+ .footer)`).
    pub(super) fn confirmation(mut self, confirmation: bool) -> Self {
        self.confirmation = confirmation;
        self
    }
}

impl ParentElement for DialogHeader {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for DialogHeader {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let frame = frame(cx);
        let mut header = div()
            .flex()
            .flex_col()
            .gap(ds.len(Length::Space2))
            .pr(ds.len(Length::Space6));
        if frame.scroll_body {
            header = header.pb(ds.len(Length::Space3));
        }
        if self.confirmation {
            let min = ds.len(Length::TypoPanelTitleLineHeight)
                + ds.len(Length::Space2)
                + ds.len(Length::TypoBodyLineHeight);
            header = header.min_h(min).justify_center();
        }
        strut::dialog_scope(
            DialogFrame {
                in_header: true,
                ..frame
            },
            header.children(self.children),
        )
    }
}

type Close = Rc<dyn Fn(&mut Window, &mut App)>;

/// The actions row: `justify-content: flex-end; gap: --space-2`.
#[derive(IntoElement, Default)]
pub struct DialogFooter {
    close: Option<(SharedString, Close)>,
    children: Vec<AnyElement>,
}

impl DialogFooter {
    pub fn new() -> Self {
        Self::default()
    }

    /// `showCloseButton` with `closeLabel`: an outline Button after the children that runs `close`.
    pub fn close_button(
        mut self,
        label: impl Into<SharedString>,
        close: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        self.close = Some((label.into(), Rc::new(close)));
        self
    }
}

impl ParentElement for DialogFooter {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for DialogFooter {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let mut footer = div()
            .flex()
            .justify_end()
            .gap(ds.len(Length::Space2))
            .children(self.children);
        if frame(cx).scroll_body {
            footer = footer.pt(ds.len(Length::Space4));
        }
        let close = self.close.map(|(label, close)| {
            Button::new("dialog-footer-close")
                .variant(Variant::Outline)
                .text(label)
                .on_click(move |_, window, cx| close(window, cx))
        });
        footer.children(close)
    }
}

/// The title: the panel-title type, kept clear of the close button on its end.
#[derive(IntoElement)]
pub struct DialogTitle {
    text: SharedString,
    visually_hidden: bool,
}

impl DialogTitle {
    pub fn new(text: impl Into<SharedString>) -> Self {
        Self {
            text: text.into(),
            visually_hidden: false,
        }
    }

    /// Keeps the accessible name and hides the title (`sr-only`).
    pub fn visually_hidden(mut self) -> Self {
        self.visually_hidden = true;
        self
    }
}

impl RenderOnce for DialogTitle {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        if self.visually_hidden {
            return div().absolute().size_0().into_any_element();
        }
        let ds = Ds::get(cx);
        let frame = frame(cx);
        // A header insets its own end, so its title reserves only what is left of the room.
        let room = if frame.in_header {
            (frame.close_room - f32::from(ds.len(Length::Space6))).max(0.)
        } else {
            frame.close_room
        };
        div()
            .pr(px(room))
            .text_color(ds.color(Color::TextPrimary))
            .text_size(ds.len(Length::TypoPanelTitleSize))
            .line_height(ds.len(Length::TypoPanelTitleLineHeight))
            .font_weight(FontWeight(ds.number(Number::TypoPanelTitleWeight)))
            .child(self.text)
            .into_any_element()
    }
}

/// The description: secondary text on the body line.
#[derive(IntoElement)]
pub struct DialogDescription(SharedString);

impl DialogDescription {
    pub fn new(text: impl Into<SharedString>) -> Self {
        Self(text.into())
    }
}

impl RenderOnce for DialogDescription {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        div()
            .text_color(ds.color(Color::TextSecondary))
            .text_size(ds.len(Length::FontSize3))
            .line_height(ds.len(Length::TypoBodyLineHeight))
            .child(self.0)
    }
}
