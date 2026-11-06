//! DS Avatar (Avatar.tsx / Avatar.module.css, avatarInitials.ts): a person's initial in a small
//! circle, shown right after an item's title for its assignee. The optional badge marks an
//! agent working for them: it fades in and out at the circle's corner. The circle's box is
//! always the size token; while a badge shows, an end margin holds its overhang.
use gpui::{
    App, BoxShadow, ElementId, FontWeight, Hsla, IntoElement, ParentElement as _, Pixels,
    RenderOnce, SharedString, Styled as _, Window, div, point, px,
};

use super::Icon;
use super::context::Ds;
use super::convert;
use super::icon::icon_px;
use super::presence::{Presence, PresenceMotion};
use super::tooltip::Tooltip;
use super::typo::Typo;
use crate::tokens::{Color, Length, Number};

/// `Xs` 16px: sidebar rows, cards, list rows. `Sm` 20px: panel titles, activity rows. `Md` 24px:
/// headers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AvatarSize {
    #[default]
    Xs,
    Sm,
    Md,
}

/// `Own`: the signed-in person (muted). `Other`: anyone else (accent tint).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AvatarTone {
    #[default]
    Own,
    Other,
}

/// The one-letter initial of a name: its first letter or digit (the first character when it has
/// none), uppercased when that keeps it one letter. "하린" is "하", "minji" is "M", "@minji" is
/// "M". Characters stand in for grapheme clusters (a combined emoji keeps only its first scalar).
pub fn initials(name: &str) -> String {
    let name = name.trim();
    let first = name
        .chars()
        .find(|c| c.is_alphanumeric())
        .or_else(|| name.chars().next());
    let Some(first) = first else {
        return String::new();
    };
    let mut upper = first.to_uppercase();
    match (upper.next(), upper.next()) {
        (Some(one), None) => one.to_string(),
        _ => first.to_string(),
    }
}

#[derive(IntoElement)]
pub struct Avatar {
    id: ElementId,
    name: SharedString,
    initials: Option<SharedString>,
    size: AvatarSize,
    tone: AvatarTone,
    badge: Option<Icon>,
    label: Option<SharedString>,
    decorative: bool,
}

impl Avatar {
    /// `name` is the person's display name; the initial and the accessible name come from it.
    pub fn new(id: impl Into<ElementId>, name: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            initials: None,
            size: AvatarSize::Xs,
            tone: AvatarTone::Own,
            badge: None,
            label: None,
            decorative: false,
        }
    }

    /// Overrides the derived initial (one letter reads best).
    pub fn initials(mut self, initials: impl Into<SharedString>) -> Self {
        self.initials = Some(initials.into());
        self
    }

    pub fn size(mut self, size: AvatarSize) -> Self {
        self.size = size;
        self
    }

    pub fn tone(mut self, tone: AvatarTone) -> Self {
        self.tone = tone;
        self
    }

    /// The corner mark: a glyph shown while an agent works on the item for this person.
    pub fn badge(mut self, badge: Option<Icon>) -> Self {
        self.badge = badge;
        self
    }

    /// The accessible name and a tooltip, e.g. "Harin · Claude Code working". Without it the
    /// name stands in and there is no tooltip.
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// Hidden from assistive tech when the name is already written beside it.
    pub fn decorative(mut self) -> Self {
        self.decorative = true;
        self
    }

    /// The accessible name (gpui draws none of it).
    pub fn aria_label(&self) -> &SharedString {
        self.label.as_ref().unwrap_or(&self.name)
    }
}

/// The circle's fill and its hairline ring, and the ink.
fn palette(tone: AvatarTone, ds: &Ds) -> (Hsla, Hsla, Hsla) {
    let raised = ds.color(Color::ColorSurfaceRaisedOpaque);
    match tone {
        AvatarTone::Own => (
            convert::mix(ds.color(Color::TextPrimary), raised, 0.06), // DS: Avatar.module.css:23
            ds.color(Color::Line),
            ds.color(Color::TextSecondary),
        ),
        AvatarTone::Other => {
            let accent = ds.color(Color::Accent);
            (
                convert::mix(accent, raised, 0.12), // DS: Avatar.module.css:49
                convert::with_alpha(accent, 0.24),  // DS: Avatar.module.css:53
                ds.color(Color::AccentText),
            )
        }
    }
}

/// The badge: an opaque disc with a hairline ring, so the glyph reads on any row fill.
fn badge_disc(glyph: Icon, side: Pixels, ds: &Ds) -> gpui::Div {
    let ring = BoxShadow {
        color: ds.color(Color::Line).into(),
        offset: point(px(0.), px(0.)),
        blur_radius: px(0.),
        spread_radius: ds.len(Length::BorderHairline),
        inset: false,
    };
    div()
        .flex()
        .items_center()
        .justify_center()
        .size(side)
        .rounded_full()
        .bg(ds.color(Color::ColorSurfaceRaisedOpaque))
        .shadow(vec![ring])
        .text_color(ds.color(Color::TextPrimary))
        .child(icon_px(glyph, side * 0.75)) // DS: Avatar.module.css:112
}

impl RenderOnce for Avatar {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let line = window.text_style().line_height_in_pixels(window.rem_size());
        // The badge stays drawn through its exit.
        let last = window.use_keyed_state((self.id.clone(), "badge"), cx, |_, _| None::<Icon>);
        if let Some(glyph) = self.badge {
            last.update(cx, |last, _| *last = Some(glyph));
        }
        let held = self.badge.or(*last.read(cx));
        let ds = Ds::get(cx);
        let side = ds.len(match self.size {
            AvatarSize::Xs => Length::IconSizeMd,
            AvatarSize::Sm => Length::IconSizeLg,
            AvatarSize::Md => Length::IconSizeXl,
        });
        let badge_side = ds.len(match self.size {
            AvatarSize::Xs => Length::IconSizeXs,
            _ => Length::IconSizeSm,
        });
        let hairline = ds.len(Length::BorderHairline);
        let (fill, ring, ink) = palette(self.tone, ds);
        let letter = self
            .initials
            .clone()
            .unwrap_or_else(|| SharedString::from(initials(&self.name)));
        let letter_size = f32::from(side) * 9. / 16.; // DS: Avatar.module.css:68
        let weight = ds.number(Number::FontWeightSemibold);
        let family = ds.body_font().clone();
        // `text-box: trim-both cap alphabetic`: the capitals, not the line box, are centred.
        let drop = Typo::trim_offset(&family, letter_size, cx, weight);
        let ds = Ds::get(cx);
        let initial = div().relative().top(px(drop)).child(letter);
        // `bottom: clamp(-badge / 4, (size - 1lh) / 2 + hairline, 0)`: it hangs below the circle
        // only as far as the surrounding line allows.
        let low = ((side - line) / 2. + hairline).clamp(-badge_side / 4., px(0.));
        let corner = div()
            .absolute()
            .right(-badge_side / 2.)
            .bottom(low)
            .size(badge_side)
            .child(
                Presence::new((self.id.clone(), "presence"), self.badge.is_some())
                    .motion(PresenceMotion::Fade)
                    .child(held.map_or_else(
                        || div().into_any_element(),
                        |glyph| badge_disc(glyph, badge_side, ds).into_any_element(),
                    )),
            );
        // TODO(gpui-ce butler-port-gaps): element scale transforms. The badge also pops from
        // `--motion-scale-check` while it fades (Avatar.module.css:117,126); here it only fades.
        let mut circle = div()
            .relative()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(side)
            .rounded_full()
            .bg(fill)
            .border(hairline)
            .border_color(ring)
            .text_color(ink)
            .font_family(family)
            .text_size(px(letter_size))
            .font_weight(FontWeight(weight))
            .line_height(side)
            .whitespace_nowrap()
            .child(initial);
        if self.badge.is_some() {
            circle = circle.mr(badge_side / 2. + hairline);
        }
        let circle = circle.child(corner);
        match self.label.filter(|_| !self.decorative) {
            Some(label) => Tooltip::new((self.id, "tip"))
                .label(label)
                .child(circle)
                .into_any_element(),
            None => circle.into_any_element(),
        }
    }
}
