//! DS Typo (Typo.tsx / Typo.module.css): every type role from tokens, with the text props
//! (tone, weight, align, truncate, clamp, wrap, numeric, literal, alignWith), Korean
//! `keep-all` and the cap-height trim.
mod spec;

pub use spec::Role;

use gpui::{
    AnyElement, App, FontFeatures, FontWeight, HighlightStyle, IntoElement, ParentElement as _,
    RenderOnce, SharedString, Styled as _, StyledText, Window, div, font, px,
};

use super::context::{Ds, Lang};
use super::layout::{ItemProps, WithItem};
use crate::tokens::{Color, Length, Number};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Primary,
    Secondary,
    Tertiary,
    Disabled,
    Danger,
    Success,
    Warning,
    Inherit,
}

impl Tone {
    fn color(self) -> Option<Color> {
        match self {
            Self::Primary => Some(Color::ColorTextPrimary),
            Self::Secondary => Some(Color::ColorTextSecondary),
            Self::Tertiary => Some(Color::ColorTextTertiary),
            Self::Disabled => Some(Color::ColorTextDisabled),
            Self::Danger => Some(Color::ColorDangerText),
            Self::Success => Some(Color::ColorSuccessText),
            Self::Warning => Some(Color::ColorWarningText),
            Self::Inherit => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Weight {
    Regular,
    Medium,
    Semibold,
}

impl Weight {
    fn value(self, ds: &Ds) -> f32 {
        match self {
            Self::Regular => ds.number(Number::FontWeightRegular),
            Self::Medium => ds.number(Number::FontWeightMedium),
            Self::Semibold => ds.number(Number::FontWeightSemibold),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TextAlign {
    #[default]
    Start,
    Center,
    End,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Wrap {
    #[default]
    Normal,
    Nowrap,
    /// `overflow-wrap: anywhere`.
    Anywhere,
    /// `pre-wrap` plus `anywhere`.
    Pre,
}

/// An inline run of text with its own tone or weight (`<Typo.Text>` inside a Typo).
#[derive(Clone, Debug)]
pub struct Run {
    text: SharedString,
    tone: Option<Tone>,
    weight: Option<Weight>,
}

impl Run {
    pub fn new(text: impl Into<SharedString>) -> Self {
        Self {
            text: text.into(),
            tone: None,
            weight: None,
        }
    }

    pub fn tone(mut self, tone: Tone) -> Self {
        self.tone = Some(tone);
        self
    }

    pub fn weight(mut self, weight: Weight) -> Self {
        self.weight = Some(weight);
        self
    }
}

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent text props, as the React Typo API"
)]
#[derive(IntoElement)]
pub struct Typo {
    role: Role,
    runs: Vec<Run>,
    tone: Option<Tone>,
    weight: Option<Weight>,
    align: TextAlign,
    truncate: bool,
    line_clamp: Option<usize>,
    wrap: Wrap,
    tabular: bool,
    literal: bool,
    align_with_control: bool,
    item: ItemProps,
}

impl Typo {
    pub fn new(role: Role, text: impl Into<SharedString>) -> Self {
        Self {
            role,
            runs: vec![Run::new(text)],
            tone: None,
            weight: None,
            align: TextAlign::Start,
            truncate: false,
            line_clamp: None,
            wrap: Wrap::Normal,
            tabular: false,
            literal: false,
            align_with_control: false,
            item: ItemProps::default(),
        }
    }

    /// Text in several runs.
    pub fn runs(role: Role, runs: impl IntoIterator<Item = Run>) -> Self {
        Self {
            runs: runs.into_iter().collect(),
            ..Self::new(role, "")
        }
    }

    pub fn tone(mut self, tone: Tone) -> Self {
        self.tone = Some(tone);
        self
    }

    pub fn weight(mut self, weight: Weight) -> Self {
        self.weight = Some(weight);
        self
    }

    pub fn align(mut self, align: TextAlign) -> Self {
        self.align = align;
        self
    }

    pub fn truncate(mut self) -> Self {
        self.truncate = true;
        self
    }

    pub fn line_clamp(mut self, lines: usize) -> Self {
        self.line_clamp = Some(lines);
        self
    }

    pub fn wrap(mut self, wrap: Wrap) -> Self {
        self.wrap = wrap;
        self
    }

    /// `font-variant-numeric: tabular-nums`.
    pub fn tabular(mut self) -> Self {
        self.tabular = true;
        self
    }

    /// `font-variant-ligatures: none`: exact values draw their own characters.
    pub fn literal(mut self) -> Self {
        self.literal = true;
        self
    }

    /// Pads the first line so it centres on a control row.
    pub fn align_with_control(mut self) -> Self {
        self.align_with_control = true;
        self
    }
}

macro_rules! roles {
    ($($name:ident => $role:ident),* $(,)?) => {
        impl Typo {
            $(pub fn $name(text: impl Into<SharedString>) -> Self { Self::new(Role::$role, text) })*
        }
    };
}

roles! {
    h1 => H1, h2 => H2, h3 => H3, h4 => H4, h5 => H5, h6 => H6, body => Body,
    caption => Caption, label => Label, code => Code, text => Text, app_title => AppTitle,
    panel_title => PanelTitle, dashboard_title => DashboardTitle,
    section_title => SectionTitle, panel_section_title => PanelSectionTitle,
    metric_value => MetricValue,
}

impl WithItem for Typo {
    fn item_mut(&mut self) -> &mut ItemProps {
        &mut self.item
    }
}

fn is_hangul(c: char) -> bool {
    matches!(c, '\u{1100}'..='\u{11FF}' | '\u{3130}'..='\u{318F}' | '\u{AC00}'..='\u{D7A3}')
}

/// `word-break: keep-all`: a word joiner between Hangul letters leaves the break opportunities
/// at spaces only.
fn keep_all(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    let mut previous: Option<char> = None;
    for c in text.chars() {
        if previous.is_some_and(is_hangul) && is_hangul(c) {
            out.push('\u{2060}');
        }
        out.push(c);
        previous = Some(c);
    }
    out
}

impl Typo {
    /// The joined text and the highlight runs of the runs that override tone or weight.
    fn content(
        &self,
        ds: &Ds,
        keep: bool,
    ) -> (String, Vec<(std::ops::Range<usize>, HighlightStyle)>) {
        let mut text = String::new();
        let mut highlights = Vec::new();
        for run in &self.runs {
            let start = text.len();
            if keep {
                text.push_str(&keep_all(&run.text));
            } else {
                text.push_str(&run.text);
            }
            let color = run.tone.and_then(Tone::color).map(|token| ds.color(token));
            let font_weight = run.weight.map(|weight| FontWeight(weight.value(ds)));
            if color.is_some() || font_weight.is_some() {
                highlights.push((
                    start..text.len(),
                    HighlightStyle {
                        color,
                        font_weight,
                        ..HighlightStyle::default()
                    },
                ));
            }
        }
        (text, highlights)
    }

    fn features(&self) -> Option<FontFeatures> {
        let mut features = Vec::new();
        if self.tabular {
            features.push(("tnum".to_owned(), 1));
        }
        if self.literal {
            features.extend(["calt", "clig", "liga"].map(|tag| (tag.to_owned(), 0)));
        }
        (!features.is_empty()).then(|| FontFeatures(std::sync::Arc::new(features)))
    }

    /// Distance the glyphs move down so the capitals' centre is the line's centre
    /// (`text-box: trim-both cap alphabetic` with `padding-block: (1lh - 1cap) / 2`).
    fn trim_offset(family: &SharedString, size: f32, cx: &App, weight: f32) -> f32 {
        let system = cx.text_system();
        let mut face = font(family.clone());
        face.weight = FontWeight(weight);
        let id = system.resolve_font(&face);
        let size = px(size);
        let cap = system
            .typographic_bounds(id, size, 'H')
            .map_or(0., |bounds| f32::from(bounds.size.height));
        let (ascent, descent) = (
            f32::from(system.ascent(id, size)),
            f32::from(system.descent(id, size)),
        );
        (cap + descent - ascent) / 2.
    }
}

impl RenderOnce for Typo {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let keep = ds.lang() == Lang::Ko || self.role.keeps_words();
        let (text, highlights) = self.content(ds, keep);
        let mut el = div();
        let mut trim = None;
        if let Some(role) = self.role.tokens() {
            let size = f32::from(ds.len(role.size));
            let line_height = f32::from(ds.len(role.line_height));
            let weight = self
                .weight
                .map_or_else(|| ds.number(role.weight), |w| w.value(ds));
            let family = if self.role == Role::Code {
                ds.code_font().clone()
            } else {
                ds.body_font().clone()
            };
            el = el
                .text_size(px(size))
                .line_height(px(line_height))
                .font_weight(FontWeight(weight))
                .font_family(family.clone());
            let spacing = ds.number(role.letter_spacing);
            if spacing != 0. {
                el.text_style().letter_spacing = Some(px(spacing));
            }
            trim = Some(Self::trim_offset(&family, size, cx, weight));
        } else if let Some(weight) = self.weight {
            el = el.font_weight(FontWeight(weight.value(ds)));
        }
        if let Some(color) = self.tone.and_then(Tone::color) {
            el = el.text_color(ds.color(color));
        }
        el = match self.align {
            TextAlign::Start => el,
            TextAlign::Center => el.text_center(),
            TextAlign::End => el.text_right(),
        };
        if let Some(features) = self.features() {
            el.text_style().font_features = Some(features);
        }
        el = self.layout(el, ds);
        let styled = StyledText::new(text).with_highlights(highlights);
        let body: AnyElement = match trim.filter(|_| self.line_clamp.is_none()) {
            Some(offset) => div()
                .relative()
                .top(px(offset))
                .child(styled)
                .into_any_element(),
            None => styled.into_any_element(),
        };
        self.item.apply(el, ds).child(body)
    }
}

impl Typo {
    /// Truncation, clamping, wrapping and the control-row padding.
    fn layout(&self, mut el: gpui::Div, ds: &Ds) -> gpui::Div {
        if self.truncate {
            el = el
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis();
        }
        if let Some(lines) = self.line_clamp {
            el = el.min_w_0().line_clamp(lines);
        }
        el = match self.wrap {
            Wrap::Normal | Wrap::Anywhere => el,
            Wrap::Nowrap => el.whitespace_nowrap(),
            Wrap::Pre => el.min_w_0(),
        };
        if matches!(self.wrap, Wrap::Anywhere | Wrap::Pre) {
            el = el.min_w_0();
        }
        if self.align_with_control {
            let control = if ds.compact() {
                Length::ControlHitTarget
            } else {
                Length::ControlHeightMd
            };
            let line_height = self
                .role
                .tokens()
                .map_or(0., |r| f32::from(ds.len(r.line_height)));
            let pad = ((f32::from(ds.len(control)) - line_height) / 2.).max(0.);
            el = el.py(px(pad));
        }
        el
    }
}
