//! DS SuggestionList (SuggestionList.tsx / SuggestionList.module.css): the listbox under a
//! combobox field. Focus stays in the field; rows are options it highlights. A row is one line:
//! a glyph, the title with the muted address, a badge, and the typed terms in bold. The favicon
//! image of an address row is not drawn: a glyph stands in.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, FontWeight, HighlightStyle, InteractiveElement as _, IntoElement,
    ParentElement, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _,
    StyledText, Window, div,
};

use crate::tokens::{Color, Length, Number};
use crate::ui::Icon;
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::icon::{IconSize, icon};
use crate::ui::icon_slot::{IconSlot, SlotSize, SlotTone};

type Select = Rc<dyn Fn(&mut Window, &mut App)>;

/// The listbox: the rows in a column.
#[derive(IntoElement, Default)]
pub struct SuggestionList {
    children: Vec<AnyElement>,
}

impl SuggestionList {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ParentElement for SuggestionList {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for SuggestionList {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        div().flex().flex_col().min_w_0().children(self.children)
    }
}

/// Where a suggestion comes from; a bookmark carries a star badge and a star glyph.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SuggestionKind {
    #[default]
    History,
    Bookmark,
}

/// `splitTextMatches`: the byte ranges of `text` that match any whitespace-separated query term
/// (case-insensitive), merged. Text whose lowercase form changes length is left unmatched.
fn matches(text: &str, query: &str) -> Vec<std::ops::Range<usize>> {
    let lower = text.to_lowercase();
    if lower.len() != text.len() {
        return Vec::new();
    }
    let mut marks = vec![false; text.len()];
    for term in query.to_lowercase().split_whitespace() {
        let mut from = 0;
        while let Some(at) = lower[from..].find(term) {
            let start = from + at;
            marks[start..start + term.len()].fill(true);
            from = start + lower[start..].chars().next().map_or(1, char::len_utf8);
        }
    }
    let mut ranges: Vec<std::ops::Range<usize>> = Vec::new();
    for (index, marked) in marks.iter().enumerate() {
        if !marked || !text.is_char_boundary(index) {
            continue;
        }
        match ranges.last_mut() {
            Some(last) if last.end == index => {
                last.end = index + text[index..].chars().next().map_or(1, char::len_utf8);
            }
            _ => ranges.push(index..index + text[index..].chars().next().map_or(1, char::len_utf8)),
        }
    }
    ranges
}

/// `text` with the terms of `query` in semibold (`.term`), over `color`.
fn matched(text: &str, query: &str, ds: &Ds) -> StyledText {
    let weight = FontWeight(ds.number(Number::FontWeightSemibold));
    let highlights = matches(text, query).into_iter().map(|range| {
        (
            range,
            HighlightStyle {
                font_weight: Some(weight),
                ..HighlightStyle::default()
            },
        )
    });
    StyledText::new(text.to_owned()).with_highlights(highlights)
}

/// What one row shows and does.
struct RowParts {
    id: ElementId,
    glyph: AnyElement,
    title: StyledText,
    address: Option<StyledText>,
    badge: Option<AnyElement>,
    active: bool,
    on_select: Select,
}

/// One row: the glyph column, the text, a badge; clicking chooses.
fn row(parts: RowParts, ds: &Ds) -> AnyElement {
    let RowParts {
        id,
        glyph,
        title,
        address,
        badge,
        active,
        on_select,
    } = parts;
    let hover = convert::with_alpha(ds.color(Color::Selection), 0.6); // DS: SuggestionList.module.css:26
    let strong = ds.color(Color::SelectionStrong);
    let text = div()
        .flex()
        .items_baseline()
        .min_w_0()
        .gap(ds.len(Length::SpaceSm))
        .overflow_hidden()
        .whitespace_nowrap()
        .child(
            div()
                .min_w_0()
                .max_w(gpui::relative(0.66))
                .flex_shrink(1.)
                .overflow_hidden()
                .text_ellipsis()
                .child(title),
        )
        .children(address.map(|address| {
            div()
                .min_w_0()
                .flex_1()
                .overflow_hidden()
                .text_ellipsis()
                .text_color(ds.color(Color::TextTertiary))
                .child(address)
        }));
    let mut el = div()
        .id(id)
        .flex()
        .items_center()
        .min_w_0()
        .min_h(ds.len(Length::ControlHeightLg))
        .gap(ds.len(Length::SpaceSm))
        .px(ds.len(Length::SpaceSm))
        .rounded(ds.len(Length::RadiusControl))
        .text_color(ds.color(Color::TextPrimary))
        .text_size(ds.len(Length::FontSize2))
        .line_height(ds.len(Length::TypoLabelLineHeightTight))
        .cursor_pointer()
        .child(glyph)
        .child(div().flex_1().min_w_0().child(text))
        .children(badge)
        .on_click(move |_, window, cx| on_select(window, cx));
    el = if active {
        el.bg(strong).hover_style(move |style| style.bg(strong))
    } else {
        el.hover_style(move |style| style.bg(hover))
    };
    el.into_any_element()
}

/// `SuggestionRow`: an address suggestion.
#[derive(IntoElement)]
pub struct SuggestionRow {
    id: ElementId,
    title: Option<SharedString>,
    url: SharedString,
    kind: SuggestionKind,
    query: SharedString,
    active: bool,
    on_select: Select,
}

impl SuggestionRow {
    pub fn new(
        id: impl Into<ElementId>,
        url: impl Into<SharedString>,
        on_select: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            title: None,
            url: url.into(),
            kind: SuggestionKind::History,
            query: SharedString::default(),
            active: false,
            on_select: Rc::new(on_select),
        }
    }

    /// The page title; empty (or the URL itself) shows the address alone.
    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(title.into());
        self
    }

    pub fn kind(mut self, kind: SuggestionKind) -> Self {
        self.kind = kind;
        self
    }

    /// The typed text; its terms are bold in the title and address.
    pub fn query(mut self, query: impl Into<SharedString>) -> Self {
        self.query = query.into();
        self
    }

    /// The keyboard highlight.
    pub fn active(mut self, active: bool) -> Self {
        self.active = active;
        self
    }
}

/// `splitAddress`: the host and the rest of a URL, without scheme or trailing slash.
fn address_of(url: &str) -> String {
    let value = url.trim();
    let Some((_, rest)) = value.split_once("://") else {
        return value.to_owned();
    };
    let rest = rest.trim_end_matches('/');
    rest.to_owned()
}

impl RenderOnce for SuggestionRow {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let address = address_of(&self.url);
        let address = if address.is_empty() {
            self.url.to_string()
        } else {
            address
        };
        // A page without a title records its URL as the title; show the address once.
        let named = self
            .title
            .as_ref()
            .filter(|title| !title.is_empty() && **title != self.url);
        let bookmark = self.kind == SuggestionKind::Bookmark;
        let glyph = IconSlot::new()
            .size(SlotSize::Md)
            .tone(SlotTone::Tertiary)
            .child(icon(
                if bookmark { Icon::Star } else { Icon::Globe2 },
                IconSize::Md,
                ds,
            ))
            .into_any_element();
        let (title, address) = match named {
            Some(title) => (
                matched(title, &self.query, ds),
                Some(matched(&address, &self.query, ds)),
            ),
            None => (matched(&address, &self.query, ds), None),
        };
        let badge = bookmark.then(|| {
            div()
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .text_color(ds.color(Color::AccentText))
                .child(icon(Icon::StarFilled, IconSize::Sm, ds))
                .into_any_element()
        });
        row(
            RowParts {
                id: self.id,
                glyph,
                title,
                address,
                badge,
                active: self.active,
                on_select: self.on_select,
            },
            ds,
        )
    }
}

/// `SuggestionItemRow`: an app item (a chat or project): a type glyph, the title and muted meta.
#[derive(IntoElement)]
pub struct SuggestionItemRow {
    id: ElementId,
    icon: AnyElement,
    title: SharedString,
    meta: Option<SharedString>,
    match_meta: bool,
    query: SharedString,
    active: bool,
    on_select: Select,
}

impl SuggestionItemRow {
    pub fn new(
        id: impl Into<ElementId>,
        icon: impl IntoElement,
        title: impl Into<SharedString>,
        on_select: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            icon: icon.into_any_element(),
            title: title.into(),
            meta: None,
            match_meta: false,
            query: SharedString::default(),
            active: false,
            on_select: Rc::new(on_select),
        }
    }

    /// Muted text after the title; it truncates first.
    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
        self
    }

    /// The meta is a field the query searches (a project name): its matches are bold too.
    pub fn match_meta(mut self) -> Self {
        self.match_meta = true;
        self
    }

    pub fn query(mut self, query: impl Into<SharedString>) -> Self {
        self.query = query.into();
        self
    }

    pub fn active(mut self, active: bool) -> Self {
        self.active = active;
        self
    }
}

impl RenderOnce for SuggestionItemRow {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let glyph = IconSlot::new()
            .size(SlotSize::Md)
            .tone(SlotTone::Secondary)
            .child(self.icon)
            .into_any_element();
        let meta_query = if self.match_meta {
            self.query.as_ref()
        } else {
            ""
        };
        let meta = self.meta.as_ref().map(|meta| matched(meta, meta_query, ds));
        row(
            RowParts {
                id: self.id,
                glyph,
                title: matched(&self.title, &self.query, ds),
                address: meta,
                badge: None,
                active: self.active,
                on_select: self.on_select,
            },
            ds,
        )
    }
}
