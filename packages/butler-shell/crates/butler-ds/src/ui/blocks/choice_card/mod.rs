//! DS ChoiceCard (ChoiceCard.tsx / ChoiceCard.module.css): a full-width choice row (`ChoiceCard`),
//! a compact grid tile (`ChoiceTile`) and their lists. The row has a bare leading glyph on the
//! title line, the title with an optional tag, a one-line description and a trailing control
//! (chevron, meta text, spinner or error mark) centred on the card. CheckCard rides on the same
//! surface through [`surface`].
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, Div, ElementId, IntoElement, ParentElement, Pixels, RenderOnce,
    SharedString, Styled as _, Window, div, px,
};

use super::anim::ramp;

use crate::tokens::{Color, Duration as DsDuration, Easing, Length};
use crate::ui::Icon;
use crate::ui::context::Ds;
use crate::ui::control::{Blend, Control, Disabled, DisabledLook, Width, over};
use crate::ui::convert::mix;
use crate::ui::icon::{IconSize, IconView, icon, icon_px};
use crate::ui::layout::{Space, Stack};
use crate::ui::motion::Timing;
use crate::ui::spinner::Spinner;
use crate::ui::typo::{Tone, Typo, Weight};

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// `loading` while the choice connects, `error` when it failed, `disabled` when it cannot be
/// picked now.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ChoiceState {
    #[default]
    Default,
    Loading,
    Error,
    Disabled,
}

/// The side of the leading glyph (`--choice-card-glyph-size`): `--icon-size-sm`, one step up to
/// `--icon-size-md` on a compact (640px and narrower) window, beside that ramp's larger titles.
pub fn glyph_size(ds: &Ds) -> Pixels {
    ds.len(if ds.compact() {
        Length::IconSizeMd // DS: ChoiceCard.module.css:128-133
    } else {
        Length::IconSizeSm // DS: ChoiceCard.module.css:20
    })
}

/// A DS icon at the glyph size, for the `icon` slot.
pub fn glyph(icon: Icon, cx: &App) -> IconView {
    icon_px(icon, glyph_size(Ds::get(cx)))
}

/// What the shared card surface draws.
pub(crate) struct Face {
    pub selected: bool,
    pub state: ChoiceState,
    /// Dashed, transparent tile (drawn solid: the control has no dashed border).
    pub placeholder: bool,
    /// How fast the selected and disabled looks fade (`--motion-fast`; CheckCard `--motion-base`).
    pub fade: DsDuration,
    pub padding: Length,
    pub min_height: Option<f32>,
}

/// The card surface (`.card`, `.tile`): hairline border, panel radius, control fill with hover
/// and pressed fills, the focus ring, and the selected, error and disabled looks. `body` is the
/// content; a disabled card dims it to 0.5.
pub(crate) fn surface(
    id: ElementId,
    face: &Face,
    body: AnyElement,
    on_click: Option<Handler>,
    window: &mut Window,
    cx: &mut App,
) -> Control {
    let timing = Timing::token(Ds::get(cx), face.fade, Easing::MotionEaseStandard);
    let disabled = face.state == ChoiceState::Disabled;
    let selected = ramp(
        (id.clone(), "selected"),
        (f32::from(u8::from(face.selected)), false),
        &timing,
        window,
        cx,
    );
    let dim = ramp(
        (id.clone(), "dim"),
        (if disabled { 0.5 } else { 1. }, false), // DS: ChoiceCard.module.css:105
        &timing,
        window,
        cx,
    );
    let ds = Ds::get(cx);
    let (line, strong) = (ds.color(Color::Line), ds.color(Color::LineStrong));
    let (accent, info) = (ds.color(Color::Accent), ds.color(Color::ColorInfoBg));
    let (bg, hover_bg) = (ds.color(Color::ControlBg), ds.color(Color::ControlHoverBg));
    let pressed = ds.color(Color::SelectionStrong);
    let mut control = Control::new(id, ds);
    control.width = Width::Full;
    control.inline = false;
    control.justify_center = false;
    control.scale = false;
    control.radius = ds.len(Length::RadiusPanel);
    control.min_height = face.min_height.map(px);
    let pad = ds.len(face.padding) + ds.len(Length::BorderHairline);
    control.padding = [pad; 4];
    let (rest, hover) = (mix(info, bg, selected), mix(info, hover_bg, selected));
    control.fill = if face.placeholder {
        Blend::flat(gpui::transparent_black())
    } else if disabled {
        Blend::flat(bg)
    } else {
        Blend {
            rest,
            hover,
            active: (face.state != ChoiceState::Loading).then(|| over(pressed, hover)),
        }
    };
    let border = match face.state {
        ChoiceState::Disabled => Blend::flat(line),
        ChoiceState::Error => Blend::flat(ds.color(Color::DangerLineStrong)),
        _ => Blend::hover(mix(accent, line, selected), mix(accent, strong, selected)),
    };
    control.border = Some((ds.len(Length::BorderHairline), border));
    control.disabled = if disabled {
        Disabled::Aria
    } else {
        Disabled::No
    };
    control.disabled_look = DisabledLook::Opacity(1.);
    control.not_allowed = disabled;
    let gated = (!matches!(face.state, ChoiceState::Loading | ChoiceState::Disabled))
        .then_some(on_click)
        .flatten();
    control.on_click(gated);
    control.children = vec![
        div()
            .flex()
            .flex_1()
            .min_w_0()
            .items_center()
            .opacity(dim)
            .child(body)
            .into_any_element(),
    ];
    control
}

/// The leading glyph: a box one title line tall, so the glyph centres on the title's letters.
pub(crate) fn glyph_slot(icon: AnyElement, ds: &Ds) -> Div {
    div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .w(glyph_size(ds))
        .h(ds.len(Length::TypoLabelLineHeight))
        .child(icon)
}

/// The title with its tag, and the description under it (`.titleRow`, `.description`).
pub(crate) fn text_column(
    title: SharedString,
    tag: Option<AnyElement>,
    description: Option<SharedString>,
    error: bool,
    ds: &Ds,
) -> Div {
    let title = Typo::label(title).weight(Weight::Semibold).truncate();
    let heading = div()
        .flex()
        .min_w_0()
        .items_center()
        .gap(ds.len(Length::SpaceSm))
        .child(div().flex_shrink_1().min_w_0().child(title))
        .children(tag.map(|tag| div().flex_none().child(tag)));
    let tone = if error { Tone::Danger } else { Tone::Secondary };
    div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .child(heading)
        .children(description.map(|text| {
            div()
                .min_w_0()
                .mt(ds.len(Length::BorderHairline))
                .child(Typo::caption(text).tone(tone).truncate())
        }))
}

/// The row body shared by ChoiceCard and CheckCard: glyph, text, trailing control.
pub(crate) fn row_body(
    icon: Option<AnyElement>,
    text: Div,
    end: Option<AnyElement>,
    ds: &Ds,
) -> AnyElement {
    div()
        .flex()
        .flex_1()
        .min_w_0()
        .items_center()
        .gap(ds.len(Length::SpaceMd))
        .children(icon.map(|icon| div().self_start().child(glyph_slot(icon, ds))))
        .child(text)
        .children(end)
        .into_any_element()
}

#[derive(IntoElement)]
pub struct ChoiceCard {
    id: ElementId,
    icon: AnyElement,
    title: SharedString,
    description: Option<SharedString>,
    state: ChoiceState,
    selected: bool,
    tag: Option<AnyElement>,
    meta: Option<SharedString>,
    chevron: bool,
    on_click: Option<Handler>,
}

impl ChoiceCard {
    /// `icon`: the leading glyph (a logo or [`glyph`]), shown bare at the title's text size.
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
            tag: None,
            meta: None,
            chevron: true,
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

    /// A short Tag after the title ("No key needed").
    pub fn tag(mut self, tag: impl IntoElement) -> Self {
        self.tag = Some(tag.into_any_element());
        self
    }

    /// Trailing text in place of the chevron (a size, a count).
    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
        self
    }

    /// Show the trailing chevron (default). Turn off for radio rows.
    pub fn chevron(mut self, chevron: bool) -> Self {
        self.chevron = chevron;
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

/// The trailing control: spinner while loading, the mark on error, else meta or the chevron.
fn trailing(card: &mut ChoiceCard, ds: &Ds) -> Option<AnyElement> {
    let content = match card.state {
        ChoiceState::Loading => Spinner::new((card.id.clone(), "spinner"))
            .size(14.) // DS: ChoiceCard.tsx:64
            .into_any_element(),
        ChoiceState::Error => icon(Icon::AlertCircle, IconSize::Md, ds).into_any_element(),
        _ => match card.meta.take() {
            Some(meta) => meta.into_any_element(),
            None if card.chevron => icon(Icon::ChevronRight, IconSize::Md, ds).into_any_element(),
            None => return None,
        },
    };
    let color = if card.state == ChoiceState::Error {
        Color::Danger
    } else {
        Color::TextTertiary
    };
    Some(
        div()
            .flex()
            .flex_none()
            .items_center()
            .text_color(ds.color(color))
            .child(content)
            .into_any_element(),
    )
}

impl RenderOnce for ChoiceCard {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let face = Face {
            selected: self.selected,
            state: self.state,
            placeholder: false,
            fade: DsDuration::MotionFast,
            padding: Length::SpaceMd,
            min_height: Some(64.), // DS: ChoiceCard.module.css:113
        };
        let ds = Ds::get(cx);
        let end = trailing(&mut self, ds);
        let text = text_column(
            self.title,
            self.tag.take(),
            self.description.take(),
            self.state == ChoiceState::Error,
            ds,
        );
        let body = row_body(Some(self.icon), text, end, ds);
        surface(self.id, &face, body, self.on_click, window, cx)
    }
}

/// A vertical list of cards, one per row.
#[derive(IntoElement)]
pub struct ChoiceCardList {
    children: Vec<AnyElement>,
}

impl ChoiceCardList {
    pub fn new() -> Self {
        Self {
            children: Vec::new(),
        }
    }
}

impl Default for ChoiceCardList {
    fn default() -> Self {
        Self::new()
    }
}

impl ParentElement for ChoiceCardList {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for ChoiceCardList {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        Stack::new().gap(Space::Sm).children(self.children)
    }
}

mod tile;
pub use tile::{ChoiceTile, ChoiceTileGrid};
