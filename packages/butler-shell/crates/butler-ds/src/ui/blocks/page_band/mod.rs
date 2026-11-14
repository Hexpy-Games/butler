//! DS PageBand (PageBand.tsx / PageBand.module.css): one 40px line attached to the top of a
//! PageCard for page-scoped state: who holds the tab, an approval, a request for your input,
//! picking, a blocked pop-up. Label and actions keep their size; only the detail truncates.
//! Below 560px (the band's own content width) the hint drops, below 360px the detail drops.
//! There is no idle tone: with nothing to say the band is absent.
//!
//! Not reproduced: the polite live region (`role="status"`): the shell has no accessibility
//! tree for it yet.
use gpui::{
    AnyElement, App, Bounds, ColorSpace, ElementId, Hsla, IntoElement, ParentElement as _, Pixels,
    RenderOnce, SharedString, Styled as _, Window, canvas, div, linear_color_stop, linear_gradient,
    point, px, size,
};

use super::measure;
use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::convert::mix;
use crate::ui::icon_slot::{IconSlot, SlotSize};
use crate::ui::strut;
use crate::ui::typo::{Role, Tone, Typo, Weight, Wrap};

/// `agent` Butler holds the tab (riso), `user` you hold it, `waiting` an approval waits,
/// `warning` Butler needs your input (keypad, MFA), `pick` element picking, `info` page events
/// such as a blocked pop-up.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageBandTone {
    Agent,
    User,
    Waiting,
    Warning,
    Pick,
    Info,
}

/// `@container page-band (width < 560px)`.
const HINT_MIN: f32 = 560.; // DS: PageBand.module.css:99
/// `@container page-band (width < 360px)`.
const DETAIL_MIN: f32 = 360.; // DS: PageBand.module.css:105

#[derive(IntoElement)]
pub struct PageBand {
    id: ElementId,
    tone: PageBandTone,
    icon: Option<AnyElement>,
    label: SharedString,
    detail: Option<SharedString>,
    hint: Option<SharedString>,
    actions: Option<AnyElement>,
    flush: bool,
}

impl PageBand {
    /// `label`: who holds the page or what happens, in a few words. Never truncates.
    pub fn new(
        id: impl Into<ElementId>,
        tone: PageBandTone,
        label: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            tone,
            icon: None,
            label: label.into(),
            detail: None,
            hint: None,
            actions: None,
            flush: false,
        }
    }

    /// A 16px glyph or a small ButlerThinkingMark.
    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    /// The current step or the page event; the only part that truncates.
    pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// A quiet keyboard or gesture hint; hidden when the band is narrow.
    pub fn hint(mut self, hint: impl Into<SharedString>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// Up to three `xs` buttons in a ButtonContainer (the caller builds it).
    pub fn actions(mut self, actions: impl IntoElement) -> Self {
        self.actions = Some(actions.into_any_element());
        self
    }

    /// The band on a PageCard: no line between band and page (`border-bottom-color:
    /// transparent`).
    pub fn flush(mut self) -> Self {
        self.flush = true;
        self
    }
}

/// The band's fill and the colour of its bottom line.
struct Look {
    fill: Option<Hsla>,
    line: Hsla,
}

fn look(tone: PageBandTone, ds: &Ds) -> Look {
    let raised = ds.color(Color::SurfaceRaised);
    let ink = |color: Color, share: f32| mix(ds.color(color), raised, share);
    let faint = |color: Color, share: f32| crate::ui::convert::with_alpha(ds.color(color), share);
    match tone {
        PageBandTone::Agent => Look {
            fill: None,
            line: faint(Color::ButlerInkPurple, 0.25),
        },
        PageBandTone::Pick => Look {
            fill: Some(ink(Color::Accent, 0.07)),
            line: faint(Color::Accent, 0.22),
        },
        PageBandTone::Waiting | PageBandTone::Warning => Look {
            fill: Some(ds.color(Color::ColorWarningBg)),
            line: ds.color(Color::ColorWarningBorder),
        },
        PageBandTone::Info => Look {
            fill: Some(ds.color(Color::ColorInfoBg)),
            line: ds.color(Color::ColorInfoBorder),
        },
        PageBandTone::User => Look {
            fill: Some(ds.color(Color::Muted)),
            line: ds.color(Color::Line),
        },
    }
}

/// The riso fill: `linear-gradient(90deg, blue 10%, purple 8% at 55%, pink 8%)` over the surface,
/// as two gradients (gpui gradients have two stops), running under the bottom line.
fn agent_fill(ds: &Ds, line: Pixels) -> impl IntoElement {
    let raised = ds.color(Color::SurfaceRaised);
    let stops = [
        mix(ds.color(Color::ButlerInkBlue), raised, 0.10),
        mix(ds.color(Color::ButlerInkPurple), raised, 0.08),
        mix(ds.color(Color::ButlerInkPink), raised, 0.08),
    ];
    let split = 0.55; // DS: PageBand.module.css:68
    canvas(
        |bounds: Bounds<Pixels>, _, _| bounds,
        move |_, bounds, window, _| {
            let (w, h) = (bounds.size.width, bounds.size.height + line);
            let left = Bounds::new(bounds.origin, size(w * split, h));
            let right = Bounds::new(
                point(bounds.origin.x + w * split, bounds.origin.y),
                size(w - w * split, h),
            );
            for (area, from, to) in [(left, stops[0], stops[1]), (right, stops[1], stops[2])] {
                let fill =
                    linear_gradient(90., linear_color_stop(from, 0.), linear_color_stop(to, 1.))
                        .color_space(ColorSpace::Srgb);
                window.paint_quad(gpui::PaintQuad::new(area).background(fill));
            }
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

fn slot(el: impl IntoElement) -> gpui::Div {
    div().flex_none().child(el)
}

impl PageBand {
    /// The live-region part: glyph, label and the detail (which truncates, and drops when narrow).
    fn text(&mut self, detail_fits: bool, ds: &Ds) -> gpui::Div {
        let line = ds.len(Length::BorderHairline);
        let warn = matches!(self.tone, PageBandTone::Waiting | PageBandTone::Warning);
        let glyph = self.icon.take().map(|icon| {
            let color = if warn {
                ds.color(Color::ColorWarningText)
            } else {
                ds.color(Color::TextPrimary)
            };
            slot(IconSlot::new().size(SlotSize::Md).child(icon)).text_color(color)
        });
        let detail = self.detail.take().filter(|_| detail_fits).map(|detail| {
            div()
                .flex()
                .items_center()
                .gap(ds.len(Length::SpaceSm))
                .min_w_0()
                .child(
                    div()
                        .flex_none()
                        .w(line)
                        .h(ds.len(Length::IconSizeSm))
                        .bg(ds.color(Color::LineStrong)),
                )
                .child(
                    div().min_w_0().flex_initial().child(
                        Typo::new(Role::Text, detail)
                            .tone(Tone::Secondary)
                            .truncate(),
                    ),
                )
        });
        div()
            .flex()
            .flex_auto()
            .min_w_0()
            .items_center()
            .gap(ds.len(Length::SpaceSm))
            .children(glyph)
            .child(slot(
                Typo::new(Role::Text, self.label.clone())
                    .weight(Weight::Medium)
                    .wrap(Wrap::Nowrap),
            ))
            .children(detail)
    }
}

impl RenderOnce for PageBand {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (seen, recorder) = measure::track((self.id.clone(), "band"), window, cx);
        let ds = Ds::get(cx);
        let look = look(self.tone, ds);
        let line = ds.len(Length::BorderHairline);
        let (pad_start, pad_end) = (ds.len(Length::SpaceMd), ds.len(Length::SpaceSm));
        // The container query reads the band's content width (the recorder fills the padding
        // box); unmeasured, nothing drops yet.
        let content = f32::from(seen.width - pad_start - pad_end);
        let measured = seen.width > px(0.);
        let (hint_fits, detail_fits) = (
            !measured || content >= HINT_MIN,
            !measured || content >= DETAIL_MIN,
        );
        let text = self.text(detail_fits, ds);
        let hint = self.hint.filter(|_| hint_fits).map(|hint| {
            slot(
                Typo::new(Role::Text, hint)
                    .tone(Tone::Tertiary)
                    .wrap(Wrap::Nowrap),
            )
        });
        let actions = self.actions.map(|actions| {
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(ds.len(Length::SpaceXs))
                .child(actions)
        });
        let band = div()
            .relative()
            .flex()
            .flex_none()
            .items_center()
            .gap(ds.len(Length::SpaceSm))
            .h(ds.len(Length::BrowserBandHeight))
            .pl(pad_start)
            .pr(pad_end)
            .border_b(line)
            .border_color(if self.flush {
                gpui::transparent_black()
            } else {
                look.line
            })
            .text_color(ds.color(Color::TextPrimary))
            .text_size(ds.len(Length::FontSize2))
            .line_height(ds.len(Length::TypoLabelLineHeightTight));
        let band = match look.fill {
            Some(fill) => band.bg(fill),
            None => band.child(agent_fill(ds, line)),
        };
        strut::scope(
            false,
            band.child(recorder)
                .child(text)
                .children(hint)
                .children(actions),
        )
    }
}
