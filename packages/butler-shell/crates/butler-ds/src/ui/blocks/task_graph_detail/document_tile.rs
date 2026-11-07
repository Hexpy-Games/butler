//! DS DocumentTile (DocumentTile.tsx / DocumentTile.module.css): a document card. A leading icon
//! on the title line, a two-line title, one caption line (badge, description · meta) and an
//! action. With `ClickTarget::Tile` the whole tile is the button; otherwise a borderless button
//! at the end opens it. The action list and link actions are not ported (the task detail uses
//! neither), nor the stacked layout under 520px.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, IntoElement, ParentElement as _, RenderOnce,
    SharedString, Styled as _, Window, div,
};

use crate::tokens::{Color, Length};
use crate::ui::button::{Button, Size as ButtonSize, Variant as ButtonVariant};
use crate::ui::card::Card;
use crate::ui::context::Ds;
use crate::ui::layout::{Cross, Space, Stack};
use crate::ui::tag::Tag;
use crate::ui::typo::{Tone, Typo, Weight, Wrap};

/// What opens the document (`clickTarget`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ClickTarget {
    /// The action button at the end of the tile.
    #[default]
    Action,
    /// The whole tile.
    Tile,
}

type OpenHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct DocumentTile {
    id: ElementId,
    title: SharedString,
    description: Option<SharedString>,
    meta: Option<SharedString>,
    badge: Option<SharedString>,
    icon: Option<AnyElement>,
    action_label: Option<SharedString>,
    click_target: ClickTarget,
    on_open: Option<OpenHandler>,
}

impl DocumentTile {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            description: None,
            meta: None,
            badge: None,
            icon: None,
            action_label: None,
            click_target: ClickTarget::Action,
            on_open: None,
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
        self
    }

    pub fn badge(mut self, badge: impl Into<SharedString>) -> Self {
        self.badge = Some(badge.into());
        self
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    /// The label of the end button (`click_target(Action)`).
    pub fn action_label(mut self, label: impl Into<SharedString>) -> Self {
        self.action_label = Some(label.into());
        self
    }

    pub fn click_target(mut self, target: ClickTarget) -> Self {
        self.click_target = target;
        self
    }

    pub fn on_open(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_open = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for DocumentTile {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let tile_click = self.click_target == ClickTarget::Tile && self.on_open.is_some();
        let second_line = [self.description, self.meta]
            .into_iter()
            .flatten()
            .map(|text| text.to_string())
            .collect::<Vec<_>>()
            .join(" · ");
        let mut copy = Stack::new().gap(Space::Xs).child(
            Typo::body(self.title)
                .weight(Weight::Medium)
                .line_clamp(2)
                .wrap(Wrap::Anywhere),
        );
        if self.badge.is_some() || !second_line.is_empty() {
            copy = copy.child(
                Stack::row()
                    .gap(Space::Xs)
                    .cross(Cross::Center)
                    .children(
                        self.badge
                            .map(|badge| Tag::new((self.id.clone(), "badge"), badge)),
                    )
                    .children((!second_line.is_empty()).then(|| {
                        div()
                            .min_w_0()
                            .child(Typo::caption(second_line).tone(Tone::Secondary).truncate())
                    })),
            );
        }
        let icon = self.icon.map(|icon| {
            div()
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .h(ds.len(Length::TypoBodyLineHeight))
                .text_color(ds.color(Color::TextTertiary))
                .child(icon)
        });
        let body = div()
            .flex()
            .items_start()
            .flex_1()
            .min_w_0()
            .gap(ds.len(Length::SpaceSm))
            .children(icon)
            .child(div().flex_1().min_w_0().child(copy));
        let action = match (tile_click, self.action_label, self.on_open.clone()) {
            (false, Some(label), Some(open)) => Some(
                Button::new((self.id.clone(), "open"))
                    .variant(ButtonVariant::Borderless)
                    .size(ButtonSize::Xs)
                    .text(label)
                    .on_click(move |event, window, cx| open(event, window, cx)),
            ),
            _ => None,
        };
        let mut card = Card::new(self.id);
        if let (true, Some(open)) = (tile_click, self.on_open) {
            card = card
                .interactive()
                .on_click(move |event, window, cx| open(event, window, cx));
        }
        card.child(
            div()
                .flex()
                .items_start()
                .gap(ds.len(Length::SpaceSm))
                .min_w_0()
                .child(body)
                .children(action.map(|button| div().flex_none().child(button))),
        )
    }
}
