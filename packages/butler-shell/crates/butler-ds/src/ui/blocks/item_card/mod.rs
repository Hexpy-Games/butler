//! DS ItemCard (ItemCard.tsx / ItemCardText.tsx / ItemCard.module.css): one found item (a paper,
//! a place, a recipe, a product, a library) on a Card: picture, eyebrow, subtitle, title, a
//! value, facts, text and a footer with its source and actions. The card's own width decides the
//! layout, as the CSS container query does: below 340px it stacks and the footer keeps only the
//! read time; from 340px it is a row with a 112px picture on the start side and the footer adds
//! the site icon and name. With `on_open` the whole card opens the item; the picture (with
//! `on_media_open`), the source line, Show more and the actions keep their own targets.
mod parts;
mod skeleton;

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, ImageSource, InteractiveElement as _, IntoElement,
    MouseButton, ParentElement, RenderOnce, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window, div, px,
};

pub use self::skeleton::ItemCardSkeleton;
use super::measure;
use crate::tokens::{Color, Length};
use crate::ui::context::Ds;

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// The width from which the card is a row (`@container item-card (width >= 340px)`).
const ROW_FROM: f32 = 340.; // DS: ItemCard.module.css:121
/// The row card's picture column.
const ROW_MEDIA: f32 = 112.; // DS: ItemCard.module.css:133

/// A labelled value, already formatted by the container ("76,390원", "4.6 km").
pub struct ItemValue {
    pub amount: SharedString,
    /// An earlier or reference amount, struck through.
    pub was: Option<SharedString>,
    /// One condition line under the amount.
    pub note: Option<SharedString>,
}

impl ItemValue {
    pub fn new(amount: impl Into<SharedString>) -> Self {
        Self {
            amount: amount.into(),
            was: None,
            note: None,
        }
    }

    pub fn was(mut self, was: impl Into<SharedString>) -> Self {
        self.was = Some(was.into());
        self
    }

    pub fn note(mut self, note: impl Into<SharedString>) -> Self {
        self.note = Some(note.into());
        self
    }
}

/// Where the card's values were read: the footer's provenance line, a button that opens the page.
pub struct ItemSource {
    site: SharedString,
    checked: Option<SharedString>,
    icon: Option<ImageSource>,
    on_open: Handler,
}

impl ItemSource {
    pub fn new(
        site: impl Into<SharedString>,
        on_open: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            site: site.into(),
            checked: None,
            icon: None,
            on_open: Rc::new(on_open),
        }
    }

    /// The formatted read time ("오후 5:41 확인"). A row card shows "site · checked".
    pub fn checked(mut self, checked: impl Into<SharedString>) -> Self {
        self.checked = Some(checked.into());
        self
    }

    /// The favicon; a globe without it.
    pub fn icon(mut self, icon: impl Into<ImageSource>) -> Self {
        self.icon = Some(icon.into());
        self
    }
}

#[derive(IntoElement)]
pub struct ItemCard {
    id: ElementId,
    title: SharedString,
    eyebrow: Option<SharedString>,
    subtitle: Option<SharedString>,
    media: Option<AnyElement>,
    value: Option<ItemValue>,
    facts: Vec<SharedString>,
    text: Option<SharedString>,
    toggle_labels: Option<(SharedString, SharedString)>,
    source: Option<ItemSource>,
    actions: Vec<AnyElement>,
    on_open: Option<Handler>,
    on_media_open: Option<Handler>,
}

impl ItemCard {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            eyebrow: None,
            subtitle: None,
            media: None,
            value: None,
            facts: Vec::new(),
            text: None,
            toggle_labels: None,
            source: None,
            actions: Vec::new(),
            on_open: None,
            on_media_open: None,
        }
    }

    /// A short Tag above the title: a rank or a reason.
    pub fn eyebrow(mut self, eyebrow: impl Into<SharedString>) -> Self {
        self.eyebrow = Some(eyebrow.into());
        self
    }

    /// Author, venue, area or maker, one line above the title.
    pub fn subtitle(mut self, subtitle: impl Into<SharedString>) -> Self {
        self.subtitle = Some(subtitle.into());
        self
    }

    /// A MediaFrame; the container picks one aspect for the whole set.
    pub fn media(mut self, media: impl IntoElement) -> Self {
        self.media = Some(media.into_any_element());
        self
    }

    pub fn value(mut self, value: ItemValue) -> Self {
        self.value = Some(value);
        self
    }

    /// Short facts, one dot-separated line that wraps.
    pub fn facts(mut self, facts: impl IntoIterator<Item = impl Into<SharedString>>) -> Self {
        self.facts = facts.into_iter().map(Into::into).collect();
        self
    }

    /// Plain text. A vertical card clamps it to four lines; with both labels a button reveals
    /// the rest.
    pub fn text(mut self, text: impl Into<SharedString>) -> Self {
        self.text = Some(text.into());
        self
    }

    pub fn toggle_labels(
        mut self,
        more: impl Into<SharedString>,
        less: impl Into<SharedString>,
    ) -> Self {
        self.toggle_labels = Some((more.into(), less.into()));
        self
    }

    pub fn source(mut self, source: ItemSource) -> Self {
        self.source = Some(source);
        self
    }

    /// A footer IconButton or CopyButton (icon-sm).
    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.actions.push(action.into_any_element());
        self
    }

    /// Opens the item (its page): the whole card is the target; the title is its one tab stop.
    pub fn on_open(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_open = Some(Rc::new(handler));
        self
    }

    /// Opens the picture itself (an image viewer): the picture becomes its own button.
    pub fn on_media_open(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_media_open = Some(Rc::new(handler));
        self
    }
}

/// A part with its own target: a press on it never starts the card's click.
pub(super) fn own_target(part: gpui::Div) -> gpui::Div {
    part.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
}

impl RenderOnce for ItemCard {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let id = self.id.clone();
        let (size, recorder) = measure::track((id.clone(), "size"), window, cx);
        let row = f32::from(size.width) >= ROW_FROM;
        let hover = window.use_keyed_state((id.clone(), "hover"), cx, |_, _| false);
        let parts = window.use_keyed_state((id.clone(), "parts"), cx, |_, _| [false; 4]);
        let body = parts::body(&mut self, (row, f32::from(size.width)), &parts, window, cx);
        let media_over = parts.read(cx)[0];
        let media = self
            .media
            .take()
            .map(|media| parts::media(&id, media, &mut self, (&parts, media_over)));
        let footer = parts::footer(&mut self, row, &parts, window, cx);
        let ds = Ds::get(cx);
        let open = self.on_open.clone();
        let over_part = parts.read(cx).iter().any(|over| *over);
        let hovered = *hover.read(cx);
        let fill = if open.is_some() && hovered && !over_part {
            Color::Selection
        } else {
            Color::SurfaceRaised
        };
        let gap = ds.len(Length::SpaceSm);
        let top = if row {
            let mut top = div().flex().flex_1().min_h_0().gap(ds.len(Length::SpaceMd));
            if let Some(media) = media {
                top = top.child(div().flex_none().w(px(ROW_MEDIA)).child(media));
            }
            top.child(body)
        } else {
            let mut top = div().flex().flex_col().flex_1().min_h_0().gap(gap);
            if let Some(media) = media {
                top = top.child(div().min_w_0().child(media));
            }
            top.child(body)
        };
        let mut card = div()
            .id((id.clone(), "card"))
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .gap(gap)
            .p(ds.len(Length::Space2))
            .border(ds.len(Length::BorderHairline))
            .border_color(ds.color(Color::Line))
            .rounded(ds.len(Length::RadiusControl))
            .bg(ds.color(fill))
            .text_color(ds.color(Color::TextPrimary))
            .child(top)
            .children(footer);
        if let Some(open) = open {
            let tracked = hover.clone();
            card = card
                .cursor_pointer()
                .on_hover(move |on, _, cx| {
                    tracked.update(cx, |hovered, cx| {
                        *hovered = *on;
                        cx.notify();
                    });
                })
                .on_click(move |event, window, cx| open(event, window, cx));
        }
        div()
            .relative()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .child(recorder)
            .child(card)
    }
}
