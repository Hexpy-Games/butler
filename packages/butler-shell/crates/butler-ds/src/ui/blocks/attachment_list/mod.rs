//! DS AttachmentList (AttachmentList.tsx / attachmentStatus.tsx and their CSS): a list of
//! attachments as rows with sizes, removable chips, or square tiles (`tiles.rs`). Element items
//! lead the list as ElementChips. A blocked item stays and dims with its reason in the name's
//! tooltip; an upload shows a spinner, a failed one the danger tone.
mod tiles;

use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, ImageSource, IntoElement, ObjectFit, ParentElement, RenderOnce,
    SharedString, Styled as _, StyledImage as _, Window, div, img, px,
};

use super::element_chip::ElementChip;
use super::measure;
use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::button::{Button, Size, Variant as ButtonVariant};
use crate::ui::clickable::{Clickable, Variant as ClickVariant};
use crate::ui::context::Ds;
use crate::ui::icon::{IconSize, icon};
use crate::ui::spinner::Spinner;
use crate::ui::tooltip::Tooltip;
use crate::ui::typo::{Tone, Typo};

type Handler = Rc<dyn Fn(&SharedString, &mut Window, &mut App)>;

/// How a thumbnail sits in its frame.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ThumbnailFit {
    #[default]
    Cover,
    Contain,
}

/// An upload still running or one that failed; `meta` says how far or what to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Upload {
    Uploading,
    Failed,
}

#[derive(Clone)]
pub struct AttachmentItem {
    id: SharedString,
    name: SharedString,
    meta: Option<SharedString>,
    icon: Option<Icon>,
    thumbnail: Option<(ImageSource, ThumbnailFit)>,
    blocked_reason: Option<SharedString>,
    element_site: Option<SharedString>,
    extension: Option<SharedString>,
    upload: Option<Upload>,
}

impl AttachmentItem {
    pub fn new(id: impl Into<SharedString>, name: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            meta: None,
            icon: None,
            thumbnail: None,
            blocked_reason: None,
            element_site: None,
            extension: None,
            upload: None,
        }
    }

    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
        self
    }

    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn thumbnail(mut self, src: impl Into<ImageSource>, fit: ThumbnailFit) -> Self {
        self.thumbnail = Some((src.into(), fit));
        self
    }

    /// Kept but not sendable; a few words shown in the name's tooltip.
    pub fn blocked(mut self, reason: impl Into<SharedString>) -> Self {
        self.blocked_reason = Some(reason.into());
        self
    }

    /// A picked page element: `thumbnail` is its crop, `name` its title.
    pub fn element(mut self, site: impl Into<SharedString>) -> Self {
        self.element_site = Some(site.into());
        self
    }

    /// Tiles: the file-type label on a file face.
    pub fn extension(mut self, extension: impl Into<SharedString>) -> Self {
        self.extension = Some(extension.into());
        self
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// The same item under a new id (`<id><suffix>`).
    pub fn with_id_suffix(mut self, suffix: &str) -> Self {
        self.id = format!("{}{suffix}", self.id).into();
        self
    }

    pub fn upload(mut self, upload: Upload) -> Self {
        self.upload = Some(upload);
        self
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Variant {
    #[default]
    List,
    Chips,
    Tiles,
}

/// `row`: 64px squares in one sideways-scrolling row (composer). `wrap`: 96px squares, wrapping
/// (a sent message).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TileLayout {
    Row,
    #[default]
    Wrap,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TileAlign {
    #[default]
    End,
    Start,
}

#[derive(IntoElement)]
pub struct AttachmentList {
    id: ElementId,
    items: Vec<AttachmentItem>,
    empty_label: SharedString,
    variant: Variant,
    layout: TileLayout,
    align: TileAlign,
    on_open: Option<Handler>,
    on_remove: Option<Handler>,
    remove_label: Rc<dyn Fn(&str) -> String>,
}

impl AttachmentList {
    pub fn new(id: impl Into<ElementId>, items: Vec<AttachmentItem>) -> Self {
        Self {
            id: id.into(),
            items,
            empty_label: "No attachments".into(),
            variant: Variant::List,
            layout: TileLayout::Wrap,
            align: TileAlign::End,
            on_open: None,
            on_remove: None,
            remove_label: Rc::new(|name| format!("Remove {name}")),
        }
    }

    pub fn empty_label(mut self, label: impl Into<SharedString>) -> Self {
        self.empty_label = label.into();
        self
    }

    pub fn variant(mut self, variant: Variant) -> Self {
        self.variant = variant;
        self
    }

    pub fn tile_layout(mut self, layout: TileLayout) -> Self {
        self.layout = layout;
        self
    }

    pub fn tile_align(mut self, align: TileAlign) -> Self {
        self.align = align;
        self
    }

    /// Opens an item in the app: the name (list, chips) or the tile becomes a button.
    pub fn on_open(
        mut self,
        handler: impl Fn(&SharedString, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_open = Some(Rc::new(handler));
        self
    }

    pub fn on_remove(
        mut self,
        handler: impl Fn(&SharedString, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_remove = Some(Rc::new(handler));
        self
    }

    /// The remove button's label from the item's name; the default is "Remove <name>".
    pub fn remove_label(mut self, label: impl Fn(&str) -> String + 'static) -> Self {
        self.remove_label = Rc::new(label);
        self
    }
}

/// A list or chip preview: upload status, an image, or the file glyph.
fn preview(item: &AttachmentItem, ds: &Ds) -> AnyElement {
    let tertiary = ds.color(Color::TextTertiary);
    let slot = |color, child: AnyElement| {
        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .text_color(color)
            .child(child)
            .into_any_element()
    };
    if let Some(status) = item.upload {
        return match status {
            Upload::Uploading => slot(
                tertiary,
                Spinner::new((ElementId::from(item.id.clone()), "spin"))
                    .size(14.)
                    .into_any_element(),
            ),
            Upload::Failed => slot(
                ds.color(Color::Danger),
                icon(Icon::AlertCircle, IconSize::Sm, ds).into_any_element(),
            ),
        };
    }
    let Some((src, fit)) = item.thumbnail.clone() else {
        let glyph = item.icon.unwrap_or(Icon::FileText);
        let color = if item.blocked_reason.is_some() {
            ds.color(Color::InteractiveDisabledFg)
        } else {
            tertiary
        };
        return slot(color, icon(glyph, IconSize::Sm, ds).into_any_element());
    };
    let side = ds.len(Length::Space6);
    div()
        .flex_none()
        .overflow_hidden()
        .size(side)
        .rounded(ds.len(Length::RadiusControl))
        .bg(ds.color(Color::SurfaceRaised))
        .opacity(if item.blocked_reason.is_some() {
            0.55
        } else {
            1.
        })
        .child(
            img(src)
                .size_full()
                .rounded(ds.len(Length::RadiusControl))
                .object_fit(match fit {
                    ThumbnailFit::Cover => ObjectFit::Cover,
                    ThumbnailFit::Contain => ObjectFit::Contain,
                }),
        )
        .into_any_element()
}

/// The name: a bare-text button with `on_open`, else text; the tooltip shows the reason or name.
fn name(item: &AttachmentItem, open: Option<Handler>, ds: &Ds) -> AnyElement {
    let color = if item.blocked_reason.is_some() {
        Tone::Disabled
    } else {
        Tone::Primary
    };
    let text = Typo::text(item.name.clone()).tone(color).truncate();
    let tip = item
        .blocked_reason
        .clone()
        .unwrap_or_else(|| item.name.clone());
    let id = ElementId::from(item.id.clone());
    let target: AnyElement = match open {
        Some(open) => {
            let which = item.id.clone();
            Clickable::new((id.clone(), "open"))
                .variant(ClickVariant::Text)
                .on_click(move |_, window, cx| open(&which, window, cx))
                .child(text)
                .into_any_element()
        }
        None => text.into_any_element(),
    };
    let _ = ds;
    div()
        .flex()
        .flex_1()
        .min_w_0()
        .child(Tooltip::new((id, "tip")).label(tip).fill().child(target))
        .into_any_element()
}

/// One row (list) or chip: preview, name, remove, then the size.
fn row(item: &AttachmentItem, list: &AttachmentList, chip: Option<f32>, ds: &Ds) -> AnyElement {
    let id = ElementId::from(item.id.clone());
    let mut row = div()
        .flex()
        .items_center()
        .min_w_0()
        .gap(ds.len(Length::SpaceXs))
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .rounded(ds.len(Length::RadiusPill))
        .bg(ds.color(Color::ComposerGlassControlBg));
    row = if let Some(width) = chip {
        row.w(px(width))
            .min_h(px(22.))
            .py(px(2.))
            .px(ds.len(Length::Space1))
            .text_size(ds.len(Length::FontSize2))
            .line_height(ds.len(Length::TypoLabelLineHeight))
    } else {
        row.min_h(px(28.))
            .py(ds.len(Length::SpaceXs))
            .px(ds.len(Length::SpaceSm))
    };
    row = row
        .child(preview(item, ds))
        .child(name(item, list.on_open.clone(), ds));
    if let Some(remove) = list.on_remove.clone() {
        let which = item.id.clone();
        let label = (list.remove_label)(&item.name);
        row = row.child(
            Tooltip::new((id.clone(), "remove-tip")).label(label).child(
                Button::new((id.clone(), "remove"))
                    .size(Size::IconXs)
                    .variant(ButtonVariant::Borderless)
                    .icon_start(icon(Icon::X, IconSize::Sm, ds))
                    .on_click(move |_, window, cx| remove(&which, window, cx)),
            ),
        );
    }
    let narrow = chip.is_some_and(|width| width <= CHIP_META_HIDDEN);
    if let (Some(meta), false) = (item.meta.clone(), narrow) {
        row = row.child(
            div()
                .flex_none()
                .child(Typo::text(meta).tone(Tone::Tertiary).truncate()),
        );
    }
    row.into_any_element()
}

/// `@container attachment-chip (width <= 192px)`: the size hides first in a narrow chip.
const CHIP_META_HIDDEN: f32 = 192.; // DS: AttachmentList.module.css:136

fn element_chips(list: &AttachmentList) -> Option<AnyElement> {
    let chips: Vec<AnyElement> = list
        .items
        .iter()
        .filter_map(|item| {
            let site = item.element_site.clone()?;
            let mut chip = ElementChip::new(
                (ElementId::from(item.id.clone()), "element"),
                item.name.clone(),
                site,
            );
            if let Some((src, _)) = item.thumbnail.clone() {
                chip = chip.src(src);
            }
            if let Some(remove) = list.on_remove.clone() {
                let which = item.id.clone();
                chip = chip.on_remove(
                    list.remove_label.as_ref()("").trim().to_owned(),
                    move |_, window, cx| remove(&which, window, cx),
                );
            }
            Some(chip.into_any_element())
        })
        .collect();
    (!chips.is_empty()).then(|| {
        div()
            .flex()
            .flex_wrap()
            .min_w_0()
            .gap(px(4.))
            .children(chips)
            .into_any_element()
    })
}

impl RenderOnce for AttachmentList {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        if self.items.is_empty() {
            let ds = Ds::get(cx);
            return div()
                .text_size(ds.len(Length::TypoBodySize))
                .line_height(ds.len(Length::TypoBodyLineHeight))
                .child(Typo::text(self.empty_label.clone()).tone(Tone::Tertiary))
                .into_any_element();
        }
        if self.variant == Variant::Tiles {
            return tiles::render(&self, window, cx);
        }
        let (size, recorder) = measure::track((self.id.clone(), "size"), window, cx);
        let ds = Ds::get(cx);
        let chips = self.variant == Variant::Chips;
        let gap = f32::from(ds.len(Length::SpaceXs));
        let inner = if chips {
            f32::from(size.width) - 2. * f32::from(ds.len(Length::SpaceLg))
        } else {
            0.
        };
        let across = if ds.tokens().viewport.0 <= 760. {
            2.
        } else {
            5.
        };
        let chip = chips.then(|| ((inner - gap * (across - 1.)) / across).max(0.));
        let elements = element_chips(&self);
        let mut list = div()
            .relative()
            .flex()
            .min_w_0()
            .w_full()
            .text_size(ds.len(Length::TypoBodySize))
            .line_height(ds.len(Length::TypoBodyLineHeight));
        list = if chips {
            list.flex_row()
                .flex_wrap()
                .gap(ds.len(Length::SpaceXs))
                .px(ds.len(Length::SpaceLg))
                .pb(px(10.))
        } else {
            list.flex_col().gap(ds.len(Length::SpaceXs))
        };
        let rows = self
            .items
            .iter()
            .filter(|item| item.element_site.is_none())
            .map(|item| row(item, &self, chip, ds));
        let elements = elements.map(|elements| {
            if chips {
                div().w_full().child(elements).into_any_element()
            } else {
                elements
            }
        });
        list.child(recorder)
            .children(elements)
            .children(rows)
            .into_any_element()
    }
}
