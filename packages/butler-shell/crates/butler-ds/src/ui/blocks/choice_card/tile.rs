//! DS ChoiceTile and ChoiceTileGrid (ChoiceCard.tsx / ChoiceCard.module.css): a compact tile with
//! a logo, a name that wraps to two lines and a one-line description, and the grid of equal-size
//! tiles.
use gpui::{
    AnyElement, App, ClickEvent, ElementId, IntoElement, ParentElement, RenderOnce, SharedString,
    Styled as _, Window, div, px,
};
use std::rc::Rc;

use super::{ChoiceState, Face, glyph_size, glyph_slot, surface};
use crate::tokens::{Color, Duration as DsDuration, Length};
use crate::ui::blocks::measure;
use crate::ui::context::Ds;
use crate::ui::spinner::Spinner;
use crate::ui::typo::{Tone, Typo, Weight};

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct ChoiceTile {
    id: ElementId,
    icon: AnyElement,
    title: SharedString,
    description: Option<SharedString>,
    state: ChoiceState,
    selected: bool,
    placeholder: bool,
    corner_icon: Option<AnyElement>,
    on_click: Option<Handler>,
}

impl ChoiceTile {
    pub fn new(
        id: impl Into<ElementId>,
        icon: impl IntoElement,
        title: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            icon: icon.into_any_element(),
            title: title.into(),
            description: None,
            state: ChoiceState::Default,
            selected: false,
            placeholder: false,
            corner_icon: None,
            on_click: None,
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn state(mut self, state: ChoiceState) -> Self {
        self.state = state;
        self
    }

    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    /// A transparent tile for a choice that is not available yet.
    pub fn placeholder(mut self, placeholder: bool) -> Self {
        self.placeholder = placeholder;
        self
    }

    /// Trailing glyph for the tile's own action (a refresh mark), centred on the tile's end.
    pub fn corner_icon(mut self, icon: impl IntoElement) -> Self {
        self.corner_icon = Some(icon.into_any_element());
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

/// The tile stacks its logo above the name below this width (`@container choice-tile`).
const STACK_BELOW: f32 = 160.; // DS: ChoiceCard.module.css:288

/// The tile's trailing glyph: a spinner while loading, else the owner's icon.
fn corner(id: &ElementId, state: ChoiceState, icon: Option<AnyElement>) -> Option<AnyElement> {
    if state == ChoiceState::Loading {
        let spinner = Spinner::new((id.clone(), "spinner"));
        return Some(spinner.size(12.).into_any_element()); // DS: ChoiceCard.tsx:93
    }
    icon
}

impl RenderOnce for ChoiceTile {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (seen, recorder) = measure::track((self.id.clone(), "size"), window, cx);
        let stacked = seen.width > px(0.) && seen.width < px(STACK_BELOW);
        let face = Face {
            selected: self.selected,
            state: self.state,
            placeholder: self.placeholder,
            fade: DsDuration::MotionFast,
            padding: Length::SpaceSm,
            min_height: None,
        };
        let ds = Ds::get(cx);
        let corner = corner(&self.id, self.state, self.corner_icon);
        let room = corner.as_ref().map(|_| ds.len(Length::SpaceMd));
        let line = ds.len(Length::TypoLabelLineHeight);
        let title = div()
            .flex()
            .h(line * 2.) // DS: ChoiceCard.module.css:245
            .min_w_0()
            .items_center()
            .flex_1()
            .pr(room.unwrap_or_default())
            .child(
                Typo::label(self.title)
                    .weight(Weight::Semibold)
                    .line_clamp(2),
            );
        let glyph = glyph_slot(self.icon, ds).h(glyph_size(ds));
        let head = if stacked {
            div().flex().flex_col().gap(ds.len(Length::SpaceXs))
        } else {
            div().flex().items_center().gap(ds.len(Length::SpaceSm))
        };
        let tone = if self.placeholder {
            Tone::Tertiary
        } else {
            Tone::Secondary
        };
        let mut content = div()
            .relative()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .gap(ds.len(Length::SpaceXs))
            .child(recorder)
            .child(head.child(glyph).child(title))
            .children(self.description.map(|text| {
                div()
                    .min_w_0()
                    .pr(room.unwrap_or_default())
                    .child(Typo::caption(text).tone(tone).truncate())
            }));
        if let Some(corner) = corner {
            content = content.child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .right_0()
                    .flex()
                    .items_center()
                    .text_color(ds.color(Color::TextTertiary))
                    .child(corner),
            );
        }
        surface(
            self.id,
            &face,
            content.into_any_element(),
            self.on_click,
            window,
            cx,
        )
    }
}

/// Equal-size tiles: two columns, three when the grid is at least 480px wide.
#[derive(IntoElement)]
pub struct ChoiceTileGrid {
    id: ElementId,
    children: Vec<AnyElement>,
}

impl ChoiceTileGrid {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            children: Vec::new(),
        }
    }
}

impl ParentElement for ChoiceTileGrid {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

const THREE_COLUMNS_FROM: f32 = 480.; // DS: ChoiceCard.module.css:209

impl RenderOnce for ChoiceTileGrid {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (seen, recorder) = measure::track(self.id, window, cx);
        let columns = if seen.width >= px(THREE_COLUMNS_FROM) {
            3
        } else {
            2
        };
        let gap = Ds::get(cx).len(Length::SpaceSm);
        let mut rows = Vec::new();
        let mut cells = self.children.into_iter();
        loop {
            let row: Vec<AnyElement> = cells.by_ref().take(columns).collect();
            if row.is_empty() {
                break;
            }
            let blanks = columns - row.len();
            rows.push(
                div()
                    .flex()
                    .gap(gap)
                    .children(
                        row.into_iter()
                            .map(|tile| div().flex().flex_1().min_w_0().child(tile)),
                    )
                    .children((0..blanks).map(|_| div().flex_1().min_w_0())),
            );
        }
        div()
            .relative()
            .flex()
            .flex_col()
            .w_full()
            .gap(gap)
            .child(recorder)
            .children(rows)
    }
}
