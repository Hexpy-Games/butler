//! DS ComposerAdjunctPanel (ComposerAdjunctPanel.tsx / ComposerAdjunctPanel.module.css): the
//! collapsible panel attached above the composer (steps, workers). Its header is a button with an
//! optional icon, a heading and, while collapsed, a one-line summary; the chevron follows the
//! text. The composer card supplies `--composer-inner-padding-*`; a panel outside one has none,
//! as in CSS where the unset variable voids the padding.
use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement, RenderOnce,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div, px,
};

use crate::tokens::{Color, Duration as DsDuration, Easing, Length};
use crate::ui::Icon;
use crate::ui::blocks::scope;
use crate::ui::collapsible::{Collapsible, KeepMounted};
use crate::ui::context::Ds;
use crate::ui::icon::icon_px;
use crate::ui::motion::{Props, Timing, Transition, transition};
use crate::ui::strut;
use crate::ui::typo::{Tone, Typo};

#[derive(IntoElement)]
pub struct ComposerAdjunctPanel {
    id: ElementId,
    heading: Option<SharedString>,
    icon: Option<AnyElement>,
    summary: Option<SharedString>,
    default_collapsed: bool,
    /// `--composer-inner-padding-inline` and `-block`, when a composer card hosts the panel.
    padding: Option<(Pixels, Pixels)>,
    children: Vec<AnyElement>,
}

use gpui::Pixels;

impl ComposerAdjunctPanel {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            heading: None,
            icon: None,
            summary: None,
            default_collapsed: false,
            padding: None,
            children: Vec::new(),
        }
    }

    pub fn heading(mut self, heading: impl Into<SharedString>) -> Self {
        self.heading = Some(heading.into());
        self
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    /// The one-line summary shown while collapsed.
    pub fn collapsed_summary(mut self, summary: impl Into<SharedString>) -> Self {
        self.summary = Some(summary.into());
        self
    }

    pub fn default_collapsed(mut self) -> Self {
        self.default_collapsed = true;
        self
    }

    /// The composer card's inner padding (inline, block).
    pub fn inner_padding(mut self, inline: Pixels, block: Pixels) -> Self {
        self.padding = Some((inline, block));
        self
    }
}

impl ParentElement for ComposerAdjunctPanel {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for ComposerAdjunctPanel {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let default = self.default_collapsed;
        let state = window.use_keyed_state((self.id.clone(), "collapsed"), cx, move |_, _| default);
        let collapsed = *state.read(cx);
        let timing = Timing::token(
            Ds::get(cx),
            DsDuration::MotionBase,
            Easing::MotionEaseStandard,
        );
        let turned = transition(
            (self.id.clone(), "chevron"),
            (if collapsed { 1. } else { 0. }, false),
            &timing,
            window,
            cx,
        );
        let ds = Ds::get(cx);
        // Without a composer card the padding's variables are unset and the whole declaration is void.
        let padding = self
            .padding
            .or_else(|| scope::composer(cx).map(|vars| (px(vars.padding.0), px(vars.padding.1))));
        let (inline, block) = padding.unwrap_or((px(0.), px(0.)));
        let top = if padding.is_some() {
            ds.len(Length::Space2)
        } else {
            px(0.)
        };
        let header = (self.heading.is_some() || self.icon.is_some()).then(|| {
            let parts = Header {
                id: self.id.clone(),
                heading: self.heading,
                icon: self.icon,
                summary: self.summary.filter(|_| collapsed),
                turned: (turned, timing),
                padding: (inline, top),
            };
            header(parts, &state, ds)
        });
        let body = Collapsible::new((self.id.clone(), "body"), !collapsed)
            .keep_mounted(KeepMounted::Hidden)
            .child(
                div()
                    .min_w_0()
                    .px(inline)
                    .pt(top)
                    .pb(block)
                    .children(self.children),
            );
        div().min_w_0().children(header).child(body)
    }
}

/// What the header button draws.
struct Header {
    id: ElementId,
    heading: Option<SharedString>,
    icon: Option<AnyElement>,
    summary: Option<SharedString>,
    /// How far the chevron has turned toward collapsed, 0 to 1.
    turned: (Transition, Timing),
    /// The inline and block padding.
    padding: (Pixels, Pixels),
}

/// A `1lh` square slot for an icon.
fn slot(child: impl IntoElement, ds: &Ds) -> gpui::Div {
    div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(ds.len(Length::TypoBodyLineHeight))
        .text_color(ds.color(Color::TextTertiary))
        .child(child)
}

fn header(parts: Header, state: &gpui::Entity<bool>, ds: &Ds) -> gpui::Stateful<gpui::Div> {
    let heading = parts.heading.map(|text| {
        div()
            .min_w_0()
            .child(Typo::body(text).truncate().tone(Tone::Inherit))
    });
    let summary = parts.summary.map(|text| {
        div().min_w_0().child(strut::flex_scope(
            false,
            Typo::caption(text).truncate().tone(Tone::Tertiary),
        ))
    });
    let chevron = slot(
        parts.turned.0.apply(
            div().child(
                icon_px(Icon::ChevronDown, ds.len(Length::IconSizeSm)).turned(
                    if parts.turned.0.moving(&parts.turned.1) {
                        0.
                    } else {
                        -std::f32::consts::FRAC_PI_2 * parts.turned.0.target()
                    },
                ),
            ),
            &parts.turned.1,
            &Props {
                rotation: Some((0., -std::f32::consts::FRAC_PI_2)),
                ..Default::default()
            },
        ),
        ds,
    );
    let on = state.clone();
    div()
        .id((parts.id, "header"))
        .flex()
        .items_center()
        .justify_start()
        .gap(ds.len(Length::Space2))
        .w_full()
        .min_w_0()
        .px(parts.padding.0)
        .py(parts.padding.1)
        .border_b(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::ComposerGlassDivider))
        .text_color(ds.color(Color::TextPrimary))
        .cursor_pointer()
        .opacity(0.68) // DS: ComposerAdjunctPanel.module.css:30
        .hover_style(|style| style.opacity(0.82))
        .on_click(move |_, _, cx| {
            on.update(cx, |collapsed, cx| {
                *collapsed = !*collapsed;
                cx.notify();
            });
        })
        .children(parts.icon.map(|icon| slot(icon, ds)))
        .children(heading)
        .children(summary)
        .child(chevron)
}
