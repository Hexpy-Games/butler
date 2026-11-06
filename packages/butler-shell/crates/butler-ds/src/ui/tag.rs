//! DS Tag (Tag.tsx / Tag.module.css): a pill chip. Status tones or a categorical label tone, an
//! optional leading icon, a trailing icon (the cue of a larger target that opens more), a remove
//! button and an edit menu (a pencil button before remove) for labels that are editable.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, FontWeight, Hsla, IntoElement, ParentElement as _,
    RenderOnce, SharedString, Styled as _, Window, div, px,
};

use super::Icon;
use super::button::{Button, Variant as ButtonVariant};
use super::context::Ds;
use super::control::Blend;
use super::convert;
use super::dropdown_menu::{DropdownMenu, DropdownMenuContent, Entry};
use super::icon::{IconSize, icon};
use super::overlay::place::Align;
use super::strut;
use crate::tokens::{Color, Length, Number};

/// A categorical label tone: a colour that names a category, not a status.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LabelTone {
    Gray,
    Red,
    Orange,
    Yellow,
    Green,
    Teal,
    Blue,
    Purple,
}

impl LabelTone {
    pub const ALL: [Self; 8] = [
        Self::Gray,
        Self::Red,
        Self::Orange,
        Self::Yellow,
        Self::Green,
        Self::Teal,
        Self::Blue,
        Self::Purple,
    ];

    /// Border, fill and ink tokens.
    fn tokens(self) -> (Color, Color, Color) {
        match self {
            Self::Gray => (
                Color::TagLabelGrayBorder,
                Color::TagLabelGrayBg,
                Color::TagLabelGrayFg,
            ),
            Self::Red => (
                Color::TagLabelRedBorder,
                Color::TagLabelRedBg,
                Color::TagLabelRedFg,
            ),
            Self::Orange => (
                Color::TagLabelOrangeBorder,
                Color::TagLabelOrangeBg,
                Color::TagLabelOrangeFg,
            ),
            Self::Yellow => (
                Color::TagLabelYellowBorder,
                Color::TagLabelYellowBg,
                Color::TagLabelYellowFg,
            ),
            Self::Green => (
                Color::TagLabelGreenBorder,
                Color::TagLabelGreenBg,
                Color::TagLabelGreenFg,
            ),
            Self::Teal => (
                Color::TagLabelTealBorder,
                Color::TagLabelTealBg,
                Color::TagLabelTealFg,
            ),
            Self::Blue => (
                Color::TagLabelBlueBorder,
                Color::TagLabelBlueBg,
                Color::TagLabelBlueFg,
            ),
            Self::Purple => (
                Color::TagLabelPurpleBorder,
                Color::TagLabelPurpleBg,
                Color::TagLabelPurpleFg,
            ),
        }
    }
}

/// Status tones (`Neutral` .. `Danger`) or a categorical label tone.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Tone {
    #[default]
    Neutral,
    Accent,
    Success,
    Warning,
    Danger,
    Label(LabelTone),
}

/// `Sm`: inline status and filter chips. `Md`: page eyebrows and hero labels.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Size {
    #[default]
    Sm,
    Md,
}

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct Tag {
    id: ElementId,
    text: SharedString,
    icon: Option<Icon>,
    icon_end: Option<Icon>,
    tone: Tone,
    size: Size,
    on_remove: Option<Handler>,
    remove_label: Option<SharedString>,
    edit_menu: Option<Vec<Entry>>,
    edit_label: Option<SharedString>,
}

impl Tag {
    /// `id` keys the tag's buttons and its edit menu.
    pub fn new(id: impl Into<ElementId>, text: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            text: text.into(),
            icon: None,
            icon_end: None,
            tone: Tone::Neutral,
            size: Size::Sm,
            on_remove: None,
            remove_label: None,
            edit_menu: None,
            edit_label: None,
        }
    }

    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    /// A trailing icon, for a Tag that is the cue of a larger target; the Tag stays
    /// non-interactive. Not drawn together with a remove button or an edit menu.
    pub fn icon_end(mut self, icon: Icon) -> Self {
        self.icon_end = Some(icon);
        self
    }

    pub fn tone(mut self, tone: Tone) -> Self {
        self.tone = tone;
        self
    }

    pub fn size(mut self, size: Size) -> Self {
        self.size = size;
        self
    }

    /// A trailing remove button inside the pill; `label` is its accessible name.
    pub fn on_remove(
        mut self,
        label: impl Into<SharedString>,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.remove_label = Some(label.into());
        self.on_remove = Some(Rc::new(handler));
        self
    }

    /// The items of the menu a pencil button opens, before remove; `label` is the button's
    /// accessible name.
    pub fn edit_menu(mut self, label: impl Into<SharedString>, entries: Vec<Entry>) -> Self {
        self.edit_label = Some(label.into());
        self.edit_menu = Some(entries);
        self
    }

    /// The accessible names of the remove and edit buttons (gpui draws none of them).
    pub fn aria_labels(&self) -> (Option<&SharedString>, Option<&SharedString>) {
        (self.remove_label.as_ref(), self.edit_label.as_ref())
    }
}

/// Border, fill and ink of a tone.
fn palette(tone: Tone, ds: &Ds) -> (Hsla, Hsla, Hsla) {
    let c = |token| ds.color(token);
    match tone {
        Tone::Neutral => (c(Color::Line), c(Color::Surface), c(Color::TextSecondary)),
        Tone::Accent => (
            convert::with_alpha(c(Color::Accent), 0.36), // DS: Tag.module.css:29
            c(Color::Surface),
            c(Color::AccentText),
        ),
        Tone::Success => (
            c(Color::ColorSuccessBorder),
            c(Color::ColorSuccessBg),
            c(Color::ColorSuccessText),
        ),
        Tone::Warning => (
            c(Color::ColorWarningBorder),
            c(Color::ColorWarningBg),
            c(Color::ColorWarningText),
        ),
        Tone::Danger => (
            c(Color::ColorDangerBorder),
            c(Color::ColorDangerBg),
            c(Color::ColorDangerText),
        ),
        Tone::Label(label) => {
            let (border, fill, ink) = label.tokens();
            (c(border), c(fill), c(ink))
        }
    }
}

impl Tag {
    /// A trailing icon button in the tag's ink (`.action`).
    fn action(
        id: (ElementId, &'static str),
        glyph: Icon,
        ink: Hsla,
        on_click: Option<Handler>,
        ds: &Ds,
    ) -> AnyElement {
        let mut button = Button::new(id)
            .variant(ButtonVariant::Inline)
            .icon_start(icon(glyph, IconSize::Xs, ds));
        if let Some(handler) = on_click {
            button = button.on_click(move |event, window, cx| handler(event, window, cx));
        }
        let mut control = button.control(ds);
        control.fg = Blend::flat(ink);
        control.into_any_element()
    }

    fn edit_button(&mut self, ink: Hsla, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
        let entries = self.edit_menu.take()?;
        let id = SharedString::from(format!("{}-edit", self.id));
        let menu = DropdownMenu::new(id.clone(), window, cx);
        let ds = Ds::get(cx);
        let trigger = menu.trigger(|toggle| {
            let mut control = Button::new((self.id.clone(), "edit"))
                .variant(ButtonVariant::Inline)
                .icon_start(icon(Icon::Pencil, IconSize::Xs, ds))
                .on_click(toggle.on_click())
                .control(ds);
            control.fg = Blend::flat(ink);
            control.into_any_element()
        });
        let mut content = DropdownMenuContent::new()
            .align(Align::Start)
            .side_offset(8.);
        for entry in entries {
            content = content.child(entry);
        }
        let content = menu.content(content, window, cx);
        Some(
            div()
                .flex()
                .child(trigger)
                .child(content)
                .into_any_element(),
        )
    }
}

impl RenderOnce for Tag {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let shrink = strut::shrink_wrap(cx);
        let (border, fill, ink) = palette(self.tone, Ds::get(cx));
        let edit = self.edit_button(ink, window, cx);
        let ds = Ds::get(cx);
        let md = self.size == Size::Md;
        let removable = self.on_remove.is_some();
        let trailing_icon = self.icon_end.filter(|_| !removable && edit.is_none());
        let (height, inline) = if md {
            (Length::TagHeightMd, Length::TagPaddingInlineMd)
        } else {
            (Length::TagHeightSm, Length::TagPaddingInlineSm)
        };
        let (size, line) = if md {
            (Length::FontSize2, Length::TypoLabelLineHeightTight)
        } else {
            (Length::FontSize1, Length::TypoCaptionLineHeightTight)
        };
        let end_padding = if removable || edit.is_some() || trailing_icon.is_some() {
            ds.len(Length::SpaceXs)
        } else {
            ds.len(inline)
        };
        let gap = if trailing_icon.is_some() {
            ds.len(Length::SpaceXs) / 2.
        } else {
            ds.len(Length::SpaceXs)
        };
        let remove = self.on_remove.take().map(|handler| {
            Self::action((self.id.clone(), "remove"), Icon::X, ink, Some(handler), ds)
        });
        let mut label = div()
            .whitespace_nowrap()
            .font_family(ds.body_font().clone())
            .text_size(ds.len(size))
            .line_height(ds.len(line))
            .font_weight(FontWeight(ds.number(Number::TypoCaptionWeight)))
            .child(self.text);
        let spacing = ds.number(Number::TypoCaptionLetterSpacing);
        if spacing != 0. {
            label.text_style().letter_spacing = Some(px(spacing));
        }
        let tag = div()
            .flex()
            .flex_none()
            .items_center()
            .self_start()
            .gap(gap)
            .min_h(ds.len(height))
            .py(ds.len(Length::TagPaddingBlock))
            .pl(ds.len(inline))
            .pr(end_padding)
            .border(ds.len(Length::BorderHairline))
            .border_color(border)
            .rounded(ds.len(Length::RadiusPill))
            .bg(fill)
            .text_color(ink)
            .children(self.icon.map(|glyph| icon(glyph, IconSize::Xs, ds)))
            .child(label)
            .children(trailing_icon.map(|glyph| icon(glyph, IconSize::Xs, ds)))
            .children(edit)
            .children(remove);
        // `width: fit-content`: a column or grid that stretches its items does not stretch it.
        if shrink {
            strut::max_content(tag).into_any_element()
        } else {
            tag.into_any_element()
        }
    }
}
