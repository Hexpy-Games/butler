//! DS GroupTile and GroupTileMore (GroupTile.tsx / GroupTile.module.css): a group (a scrap group, a
//! bookmark folder) as a folder card on the library's grid. A mosaic of its newest items fills the
//! 16:10 slot a LibraryCard uses; the name with a folder glyph, count and date sit below, and a ⋯
//! menu at the end. Cards and picks dropped on a tile go into the group.
//!
//! Differences from React, all the toolkit's: gpui has no data attributes, so `drop_id` becomes the
//! element id of the tile's outer box (the App finds the tile's bounds by it), and no accessible
//! names are drawn (`label` is accepted for the owner's accessibility tree and not drawn).
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, Div, ElementId, FontWeight, ImageSource, InteractiveElement as _,
    IntoElement, ObjectFit, ParentElement as _, RenderOnce, SharedString, Styled as _,
    StyledImage as _, Window, div, img, relative,
};

use super::library_card::{frame, menu_slot, meta};
use crate::tokens::{Color, Length, Number};
use crate::ui::Icon;
use crate::ui::card::{Card, CardPadding};
use crate::ui::context::Ds;
use crate::ui::icon::{IconSize, icon};

type Open = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// The mosaic shows the newest four.
const SHOWN: usize = 4;

/// One cell of the mosaic: a crop, a text scrap's words, a document, or a site (favicon and host)
/// for a bookmark.
pub enum GroupTilePreview {
    Image {
        src: ImageSource,
    },
    Quote {
        text: SharedString,
    },
    Document,
    Site {
        host: SharedString,
        icon: Option<ImageSource>,
    },
}

#[derive(IntoElement)]
pub struct GroupTile {
    id: ElementId,
    name: SharedString,
    meta: Option<SharedString>,
    previews: Vec<GroupTilePreview>,
    empty_label: SharedString,
    menu: Option<AnyElement>,
    on_open: Option<Open>,
    drop: bool,
    drop_hint: Option<AnyElement>,
    drop_id: Option<SharedString>,
}

impl GroupTile {
    pub fn new(
        id: impl Into<ElementId>,
        name: impl Into<SharedString>,
        previews: impl IntoIterator<Item = GroupTilePreview>,
        empty_label: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            meta: None,
            previews: previews.into_iter().collect(),
            empty_label: empty_label.into(),
            menu: None,
            on_open: None,
            drop: false,
            drop_hint: None,
            drop_id: None,
        }
    }

    /// Count and latest date ("5 scraps · Oct 10").
    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
        self
    }

    /// Accessible name of the tile ("Travel group, 5 scraps"). gpui draws no accessible names:
    /// accepted so the App's tree can carry it, not drawn here.
    pub fn label(self, _label: impl Into<SharedString>) -> Self {
        self
    }

    /// An OverflowActionMenu (open, rename, ungroup).
    pub fn menu(mut self, menu: impl IntoElement) -> Self {
        self.menu = Some(menu.into_any_element());
        self
    }

    pub fn on_open(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_open = Some(Rc::new(handler));
        self
    }

    /// A drag is over the tile: accent ring and `drop_hint`.
    pub fn drop(mut self, drop: bool) -> Self {
        self.drop = drop;
        self
    }

    /// "Add to “Travel”", on the media while a drag is over the tile.
    pub fn drop_hint(mut self, hint: impl IntoElement) -> Self {
        self.drop_hint = Some(hint.into_any_element());
        self
    }

    /// Stable id for the App's drag targeting: the element id of the tile's outer box.
    pub fn drop_id(mut self, id: impl Into<SharedString>) -> Self {
        self.drop_id = Some(id.into());
        self
    }
}

impl RenderOnce for GroupTile {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let Self {
            id,
            name,
            meta: meta_text,
            previews,
            empty_label,
            menu,
            on_open,
            drop,
            drop_hint,
            drop_id,
        } = self;
        let mut slot = frame(ds, false).child(mosaic(&previews, &empty_label, ds));
        if drop {
            slot = slot.child(drop_ring(ds));
            slot = slot.children(drop_hint.map(|hint| hint_pill(hint, ds)));
        }
        let title = div()
            .flex()
            .items_center()
            .min_w_0()
            .gap(ds.len(Length::SpaceXs))
            .pr(ds.len(Length::ControlHeightMd))
            .text_color(ds.color(Color::TextPrimary))
            .text_size(ds.len(Length::FontSize2))
            .line_height(ds.len(Length::TypoLabelLineHeight))
            .font_weight(FontWeight(ds.number(Number::FontWeightMedium)))
            .child(glyph(Icon::Folder, IconSize::Sm, ds))
            .child(one_line().child(name));
        let body = column(ds)
            .child(slot)
            .child(title)
            .children(meta_text.map(|text| meta(text, ds)));
        let layout = div()
            .relative()
            .min_w_0()
            .child(body)
            .children(menu.map(|menu| menu_slot(&id, menu)));
        let card = tile_card(id, on_open, drop).child(layout);
        match drop_id {
            Some(key) => div()
                .id(ElementId::Name(key))
                .w_full()
                .child(card)
                .into_any_element(),
            None => card.into_any_element(),
        }
    }
}

/// The last tile of a full row: how many groups are left out, opening the kind's full view.
#[derive(IntoElement)]
pub struct GroupTileMore {
    id: ElementId,
    count: usize,
    label: SharedString,
    meta: Option<SharedString>,
    on_open: Option<Open>,
}

impl GroupTileMore {
    /// `count` is how many groups the row leaves out; `label` reads "2 more groups".
    pub fn new(id: impl Into<ElementId>, count: usize, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            count,
            label: label.into(),
            meta: None,
            on_open: None,
        }
    }

    /// "View all".
    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
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

impl RenderOnce for GroupTileMore {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let count = div()
            .text_color(ds.color(Color::TextSecondary))
            .text_size(ds.len(Length::FontSize5))
            .line_height(ds.len(Length::TypoH4LineHeight))
            .font_weight(FontWeight(ds.number(Number::FontWeightStrong)))
            .child(format!("+{}", self.count));
        let centered = empty_box(ds)
            .child(glyph(Icon::Folder, IconSize::Lg, ds))
            .child(count);
        let title = div()
            .min_w_0()
            .pr(ds.len(Length::ControlHeightMd))
            .text_color(ds.color(Color::TextPrimary))
            .text_size(ds.len(Length::FontSize2))
            .line_height(ds.len(Length::TypoLabelLineHeight))
            .font_weight(FontWeight(ds.number(Number::FontWeightMedium)))
            .child(one_line().child(self.label));
        let body = column(ds)
            .child(frame(ds, false).child(centered))
            .child(title)
            .children(self.meta.map(|text| meta(text, ds)));
        tile_card(self.id, self.on_open, false)
            .child(div().min_w_0().child(body))
            .into_any_element()
    }
}

/// The folder card: interactive and opening when it has an `on_open`; `selected` shows a drop.
fn tile_card(id: ElementId, on_open: Option<Open>, selected: bool) -> Card {
    let card = Card::new(id).padding(CardPadding::Sm).selected(selected);
    match on_open {
        Some(open) => card
            .interactive()
            .on_click(move |event, window, cx| open(event, window, cx)),
        None => card,
    }
}

fn column(ds: &Ds) -> Div {
    div()
        .flex()
        .flex_col()
        .min_w_0()
        .gap(ds.len(Length::SpaceXs))
}

/// A text run clipped to one line with an ellipsis.
fn one_line() -> Div {
    div()
        .min_w_0()
        .overflow_hidden()
        .whitespace_nowrap()
        .text_ellipsis()
}

fn glyph(name: Icon, size: IconSize, ds: &Ds) -> Div {
    div()
        .flex_none()
        .text_color(ds.color(Color::TextSecondary))
        .child(icon(name, size, ds))
}

/// The slot's centered stack: a folder glyph over a line (the empty folder, the overflow tile).
fn empty_box(ds: &Ds) -> Div {
    div()
        .flex()
        .flex_col()
        .size_full()
        .items_center()
        .justify_center()
        .gap(ds.len(Length::SpaceXs))
        .text_color(ds.color(Color::TextTertiary))
        .text_size(ds.len(Length::FontSize1))
        .line_height(ds.len(Length::TypoCaptionLineHeight))
}

/// The accent ring of a drag over the tile, drawn over the media.
fn drop_ring(ds: &Ds) -> AnyElement {
    div()
        .absolute()
        .size_full()
        .rounded(ds.len(Length::RadiusControl))
        .border(ds.len(Length::BorderWidthStrong))
        .border_color(ds.color(Color::Accent))
        .into_any_element()
}

/// The hint names the group, centered at the media's top. It takes no pointer.
fn hint_pill(hint: AnyElement, ds: &Ds) -> AnyElement {
    let pill = one_line()
        .px(ds.len(Length::SpaceSm))
        .py(ds.len(Length::SpaceXs))
        .rounded(ds.len(Length::RadiusPill))
        .bg(ds.color(Color::Accent))
        .text_color(ds.color(Color::NeutralWhite))
        .text_size(ds.len(Length::FontSize1))
        .line_height(ds.len(Length::TypoCaptionLineHeight))
        .font_weight(FontWeight(ds.number(Number::FontWeightMedium)))
        .child(hint);
    div()
        .absolute()
        .top(ds.len(Length::SpaceSm))
        .left_0()
        .right_0()
        .flex()
        .justify_center()
        .px(ds.len(Length::SpaceSm))
        .child(pill)
        .into_any_element()
}

/// The newest four (1 · 2 · 3 · 2×2), or the empty folder. The gaps show the card's surface.
fn mosaic(previews: &[GroupTilePreview], empty_label: &SharedString, ds: &Ds) -> AnyElement {
    if previews.is_empty() {
        return empty_box(ds)
            .child(glyph(Icon::Folder, IconSize::Xl, ds))
            .child(empty_label.clone())
            .into_any_element();
    }
    let mut cells: Vec<AnyElement> = previews.iter().take(SHOWN).map(|p| cell(p, ds)).collect();
    let root = match cells.len() {
        1 | 2 => track(false, cells, ds),
        3 => {
            let tall = cells.remove(0);
            track(
                false,
                vec![tall, track(true, cells, ds).into_any_element()],
                ds,
            )
        }
        _ => {
            let bottom = cells.split_off(2);
            let rows = vec![
                track(false, cells, ds).into_any_element(),
                track(false, bottom, ds).into_any_element(),
            ];
            track(true, rows, ds)
        }
    };
    root.absolute().size_full().into_any_element()
}

/// A row (or column) of equal tracks, `BorderWidthStrong` apart.
fn track(column: bool, children: Vec<AnyElement>, ds: &Ds) -> Div {
    let track = div()
        .flex()
        .flex_1()
        .min_w_0()
        .min_h_0()
        .gap(ds.len(Length::BorderWidthStrong))
        .bg(ds.color(Color::SurfaceRaised));
    let track = if column { track.flex_col() } else { track };
    track.children(children)
}

fn cell(preview: &GroupTilePreview, ds: &Ds) -> AnyElement {
    let content = match preview {
        GroupTilePreview::Image { src } => img(src.clone())
            .size_full()
            .object_fit(ObjectFit::Contain)
            .into_any_element(),
        GroupTilePreview::Quote { text } => quote(text.clone(), ds),
        GroupTilePreview::Document => document(ds),
        GroupTilePreview::Site { host, icon } => site(host, icon.as_ref(), ds),
    };
    div()
        .flex()
        .flex_1()
        .items_center()
        .justify_center()
        .min_w_0()
        .min_h_0()
        .overflow_hidden()
        .bg(ds.color(Color::Muted))
        .child(content)
        .into_any_element()
}

fn quote(text: SharedString, ds: &Ds) -> AnyElement {
    div()
        .m(ds.len(Length::SpaceSm))
        .overflow_hidden()
        .text_color(ds.color(Color::TextPrimary))
        .text_size(ds.len(Length::FontSize1))
        .line_height(ds.len(Length::TypoCaptionLineHeightTight))
        .line_clamp(3)
        .child(text)
        .into_any_element()
}

/// A title bar and two lines of text.
fn document(ds: &Ds) -> AnyElement {
    let bar = |width: f32, color: Color| {
        div()
            .w(relative(width))
            .h(ds.len(Length::SpaceXs))
            .rounded(ds.len(Length::RadiusPill))
            .bg(ds.color(color))
    };
    div()
        .flex()
        .flex_col()
        .w_full()
        .gap(ds.len(Length::SpaceXs))
        .p(ds.len(Length::SpaceSm))
        .child(bar(0.6, Color::TextTertiary)) // DS: GroupTile.module.css:112
        .child(bar(1., Color::LineStrong))
        .child(bar(1., Color::LineStrong))
        .into_any_element()
}

/// A bookmark: its favicon (or the host's first letter) over the host.
fn site(host: &SharedString, icon: Option<&ImageSource>, ds: &Ds) -> AnyElement {
    let mark = div()
        .flex()
        .items_center()
        .justify_center()
        .overflow_hidden()
        .size(ds.len(Length::TagHeightSm))
        .rounded(ds.len(Length::RadiusControl))
        .bg(ds.color(Color::SurfaceRaised))
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .text_color(ds.color(Color::TextSecondary))
        .text_size(ds.len(Length::FontSize1))
        .line_height(ds.len(Length::TypoCaptionLineHeight))
        .font_weight(FontWeight(ds.number(Number::FontWeightStrong)));
    let mark = match icon {
        Some(src) => mark.child(img(src.clone()).size_full()),
        None => mark.child(
            host.chars()
                .take(1)
                .flat_map(char::to_uppercase)
                .collect::<String>(),
        ),
    };
    let name = one_line()
        .max_w_full()
        .text_color(ds.color(Color::TextSecondary))
        .text_size(ds.len(Length::FontSize1))
        .line_height(ds.len(Length::TypoCaptionLineHeight))
        .child(host.clone());
    div()
        .flex()
        .flex_col()
        .items_center()
        .min_w_0()
        .max_w_full()
        .gap(ds.len(Length::SpaceXs))
        .p(ds.len(Length::SpaceXs))
        .child(mark)
        .child(name)
        .into_any_element()
}
