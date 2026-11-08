//! DS CardList / CardListItem (`blocks/CardList/CardList.tsx`, `CardList.module.css`): a titled
//! column of cards (an icon, a title with a meta, a one-line description, actions), optionally
//! capped to a number of rows that scrolls past it.
//!
//! Settings flush variant: inside a settings section card the section card is the list's only
//! surface, so the rows drop their own border, fill, radius and padding and sit flush, divided
//! by a hairline. CSS finds that by the list sitting under `[data-slot="form-section-card"]`;
//! gpui has no ancestor selector, so the list says it: [`CardList::flush`]. Its items read it
//! while they lay out ([`FlushScope`]), a list that is not flush resets it (a list in a dialog
//! opened from a section keeps its cards).
//!
//! Not reproduced: a description that holds a control (React takes any node there; this takes
//! text), and the native scrollbar of the capped list (the edge fade shows that it scrolls).
use gpui::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement,
    LayoutId, ParentElement, Pixels, RenderOnce, SharedString, Styled as _, Window, div, px,
};

use crate::tokens::{Color, Length};
use crate::ui::card::{Card, CardPadding};
use crate::ui::context::Ds;
use crate::ui::scroll::{Axis, Config, scroller};
use crate::ui::typo::{Tone, Typo};

/// A capped list shows `rows * 80 - 8` px: a 72 px row and the `--space-2` gap
/// (`--card-list-max-height`).
const ROW_PITCH: f32 = 80.; // DS: CardList.tsx:56
const ROW_GAP: f32 = 8.; // DS: CardList.tsx:56
/// `--card-list-row-height`.
const ROW_HEIGHT: f32 = 72.; // DS: CardList.module.css:2
/// A Card's 1px border (`Card.module.css:2`), on each side.
const CARD_BORDER: f32 = 1.; // DS: Card.module.css:2

#[derive(IntoElement)]
pub struct CardList {
    id: ElementId,
    title: Option<SharedString>,
    actions: Option<AnyElement>,
    empty: Option<AnyElement>,
    max_visible_rows: Option<usize>,
    flush: bool,
    children: Vec<AnyElement>,
}

impl CardList {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            title: None,
            actions: None,
            empty: None,
            max_visible_rows: None,
            flush: false,
            children: Vec::new(),
        }
    }

    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// Trailing controls in the header row.
    pub fn actions(mut self, actions: impl IntoElement) -> Self {
        self.actions = Some(actions.into_any_element());
        self
    }

    /// Shown instead of the rows when there are none.
    pub fn empty(mut self, empty: impl IntoElement) -> Self {
        self.empty = Some(empty.into_any_element());
        self
    }

    /// Cap the list at this many rows; it scrolls past them.
    pub fn max_visible_rows(mut self, rows: usize) -> Self {
        self.max_visible_rows = Some(rows);
        self
    }

    /// The list sits in a settings section card: its rows are flush, divided by hairlines.
    pub fn flush(mut self) -> Self {
        self.flush = true;
        self
    }
}

impl ParentElement for CardList {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// The rows column: gap `--space-2`; flush rows gap `--space-md` and every row after the first
/// carries a hairline above it.
fn rows(children: Vec<AnyElement>, flush: bool, cx: &App) -> gpui::Div {
    let ds = Ds::get(cx);
    let gap = ds.len(if flush {
        Length::SpaceMd
    } else {
        Length::Space2
    });
    let line = ds.color(Color::Line);
    let column = div().flex().flex_col().w_full().min_w_0().gap(gap);
    if !flush {
        return column.children(children);
    }
    column.children(children.into_iter().enumerate().map(|(index, child)| {
        if index == 0 {
            child
        } else {
            div()
                .pt(gap)
                .border_t(px(1.)) // DS: CardList.module.css:132 (--border-hairline)
                .border_color(line)
                .child(child)
                .into_any_element()
        }
    }))
}

/// `content` in a scroller of at most `max` high, with the edge fades and `--focus-ring-room`
/// beside the rows so a ring is never clipped. `.scroller` has no padding: the first row starts
/// at the list's top edge and `max` holds the rows alone.
fn capped(
    id: &ElementId,
    content: gpui::Div,
    max: Pixels,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let (room, edge, guard) = (
        ds.len(Length::FocusRingRoom),
        ds.len(Length::ScrollFadeSize),
        ds.len(Length::SpaceXs),
    );
    let column = div().w_full().px(room).child(content);
    let area = div()
        .flex()
        .flex_col()
        .w_full()
        .min_w_0()
        .min_h_0()
        .max_h(max)
        .child(column);
    let config = Config {
        id: (id.clone(), "scroller").into(),
        axis: Axis::Y,
        size: edge,
        guard,
    };
    let built = scroller(&config, area, window, cx);
    div()
        .min_w_0()
        .overflow_hidden()
        .mx(-room)
        .max_h(max)
        .child(built.element)
        .into_any_element()
}

impl RenderOnce for CardList {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let gap = Ds::get(cx).len(Length::Space2);
        let header = (self.title.is_some() || self.actions.is_some()).then(|| {
            div()
                .flex()
                .items_center()
                .gap(gap)
                .child(
                    div().flex_auto().min_w_0().children(
                        self.title
                            .map(|title| Typo::body(title).tone(Tone::Primary)),
                    ),
                )
                .children(self.actions.map(|actions| div().flex_none().child(actions)))
        });
        let body = if self.children.is_empty() {
            self.empty
        } else {
            let content = rows(self.children, self.flush, cx);
            Some(match self.max_visible_rows {
                Some(count) => {
                    let lines = f32::from(u16::try_from(count).unwrap_or(u16::MAX));
                    let max = px(ROW_PITCH * lines - ROW_GAP);
                    capped(&self.id, content, max, window, cx)
                }
                None => content.into_any_element(),
            })
        };
        div()
            .flex()
            .flex_col()
            .w_full()
            .min_w_0()
            .gap(gap)
            .children(header)
            .children(body.map(|body| FlushScope::new(self.flush, body)))
    }
}

#[derive(IntoElement)]
pub struct CardListItem {
    id: ElementId,
    title: SharedString,
    icon: Option<AnyElement>,
    description: Option<SharedString>,
    meta: Option<AnyElement>,
    actions: Option<AnyElement>,
    selected: bool,
}

impl CardListItem {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            icon: None,
            description: None,
            meta: None,
            actions: None,
            selected: false,
        }
    }

    /// A glyph before the title, one body line square (`1em` svg).
    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    /// One line under the title; it truncates.
    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Short caption at the end of the title line (text, or any element).
    pub fn meta(mut self, meta: impl IntoElement) -> Self {
        self.meta = Some(meta.into_any_element());
        self
    }

    /// Controls at the end, one title line tall and centred on it.
    pub fn actions(mut self, actions: impl IntoElement) -> Self {
        self.actions = Some(actions.into_any_element());
        self
    }

    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }
}

/// The title line (title, then the meta at its end) over the description.
fn content(
    title: SharedString,
    meta: Option<AnyElement>,
    description: Option<SharedString>,
    ds: &Ds,
) -> gpui::Div {
    let (gap, tight) = (ds.len(Length::Space2), ds.len(Length::SpaceXs));
    let meta = meta.map(|meta| {
        div()
            .flex_none()
            .whitespace_nowrap()
            .text_size(ds.len(Length::TypoCaptionSize))
            .line_height(ds.len(Length::TypoCaptionLineHeight))
            .text_color(ds.color(Color::TextTertiary))
            .child(meta)
    });
    let title_row = div()
        .flex()
        .items_center()
        .gap(gap)
        .min_w_0()
        .child(
            div()
                .flex_auto()
                .min_w_0()
                .child(Typo::body(title).truncate()),
        )
        .children(meta);
    div()
        .flex()
        .flex_col()
        .flex_auto()
        .min_w_0()
        .gap(tight)
        .child(title_row)
        .children(description.map(|text| Typo::caption(text).tone(Tone::Secondary).truncate()))
}

impl RenderOnce for CardListItem {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let flush = flush_active(cx);
        let ds = Ds::get(cx);
        let (gap, line, card_pad) = (
            ds.len(Length::Space2),
            ds.len(Length::TypoBodyLineHeight),
            ds.len(Length::Space3),
        );
        let icon = self.icon.map(|icon| {
            div()
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(line)
                .text_color(ds.color(Color::TextTertiary))
                .child(icon)
        });
        let actions = self.actions.map(|actions| {
            div()
                .flex()
                .flex_none()
                .items_center()
                .h(line)
                .child(actions)
        });
        let row = div()
            .flex()
            .items_start()
            .w_full()
            .min_w_0()
            .gap(gap)
            .children(icon)
            .child(content(self.title, self.meta, self.description, ds))
            .children(actions);
        if flush {
            return row.into_any_element();
        }
        // `min-height` counts the card's padding and border.
        let min_row = px(ROW_HEIGHT) - card_pad * 2. - px(CARD_BORDER) * 2.;
        Card::new(self.id)
            .padding(CardPadding::Md)
            .selected(self.selected)
            .child(row.min_h(min_row))
            .into_any_element()
    }
}

/// Whether the CardList being laid out is flush: the stack of lists being laid out, innermost
/// last. Like `strut::scope`, it is read while an item lays out.
#[derive(Default)]
struct FlushStack(Vec<bool>);

impl gpui::Global for FlushStack {}

fn flush_active(cx: &App) -> bool {
    cx.try_global::<FlushStack>()
        .and_then(|stack| stack.0.last().copied())
        .unwrap_or(false)
}

/// Lays `child` out with `flush` pushed for the items inside it.
struct FlushScope {
    flush: bool,
    child: Option<AnyElement>,
}

impl FlushScope {
    fn new(flush: bool, child: impl IntoElement) -> Self {
        Self {
            flush,
            child: Some(child.into_any_element()),
        }
    }
}

impl IntoElement for FlushScope {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for FlushScope {
    type RequestLayoutState = AnyElement;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, AnyElement) {
        let mut child = self
            .child
            .take()
            .unwrap_or_else(|| gpui::Empty.into_any_element());
        cx.default_global::<FlushStack>().0.push(self.flush);
        let layout = child.request_layout(window, cx);
        cx.default_global::<FlushStack>().0.pop();
        (layout, child)
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        child: &mut AnyElement,
        window: &mut Window,
        cx: &mut App,
    ) {
        child.prepaint(window, cx);
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        child: &mut AnyElement,
        &mut (): &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        child.paint(window, cx);
    }
}
