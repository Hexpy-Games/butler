//! DS ConversationShell (ConversationShell.tsx, conversationRail.tsx, ConversationColumnGlide.tsx,
//! conversationColumn.ts, conversationAside.ts): the conversation card. One background layer, a
//! scroller with its message column, the composer reserve, a docked or floating aside and a rail
//! slot. When the aside docks or the rail's room comes or goes, the column glides to its new
//! place on the slow emphasized motion.
mod aside;
mod column;
mod rail;
mod scroll;

use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement as _, RenderOnce, SharedString,
    Styled as _, Window, div,
};

pub use aside::{AsideContent, AsideLayout, DOCK_MIN as ASIDE_DOCK_MIN, next_layout, shown};
pub use column::Gutter;
pub use scroll::{
    ConversationScroll, ConversationScrollToBottomButton, MessageListSurface, composer_edge,
    scroll_handle, scroll_to_bottom,
};

use super::measure;
use super::scope::{self, ConversationVars, Spec};
use crate::tokens::{Duration as DsDuration, Easing, GradientToken, Length};
use crate::ui::context::Ds;
use crate::ui::motion::{Props, Timing, transition};
use crate::ui::{convert, strut};
use column::{KeepOut, Narrow};

/// The conversation width from which a rail shows in full, and from which in its compact form.
const RAIL_FULL: f32 = 960.; // DS: ConversationShell.module.css:149
const RAIL_COMPACT: f32 = 720.; // DS: ConversationShell.module.css:142

#[derive(IntoElement)]
pub struct ConversationShell {
    id: ElementId,
    composer_reserve: f32,
    gutter: Gutter,
    background: Option<AnyElement>,
    rail: Option<AnyElement>,
    rail_showing: bool,
    rail_view: Option<SharedString>,
    aside: Option<AsideContent>,
    aside_float_open: bool,
    children: Vec<AnyElement>,
}

impl ConversationShell {
    pub fn new(id: impl Into<ElementId>, composer_reserve: f32) -> Self {
        Self {
            id: id.into(),
            composer_reserve,
            gutter: Gutter::default(),
            background: None,
            rail: None,
            rail_showing: false,
            rail_view: None,
            aside: None,
            aside_float_open: false,
            children: Vec::new(),
        }
    }

    /// `contentGutter`: the column's gutter on each side.
    pub fn content_gutter(mut self, gutter: Gutter) -> Self {
        self.gutter = gutter;
        self
    }

    /// A layer behind everything in the shell: over its background, clipped to it, never takes
    /// pointer input, and stays mounted while the content swaps.
    pub fn background(mut self, background: impl IntoElement) -> Self {
        self.background = Some(background.into_any_element());
        self
    }

    /// A tab rail: the column moves left only as far as needed; `showing` is whether the rail
    /// shows any tab, `view` the conversation whose room stays for the whole view.
    pub fn rail(
        mut self,
        rail: impl IntoElement,
        showing: bool,
        view: Option<SharedString>,
    ) -> Self {
        self.rail = Some(rail.into_any_element());
        self.rail_showing = showing;
        self.rail_view = view;
        self
    }

    /// Content in the right margin (session details). From a 960px shell it docks flat and the
    /// column moves left; narrower it floats on glass while `float_open`.
    pub fn aside(mut self, content: impl Fn(AsideLayout) -> AnyElement + 'static) -> Self {
        self.aside = Some(std::rc::Rc::new(content));
        self
    }

    /// Floating only: whether the aside shows. Docked, it shows whenever it is set.
    pub fn aside_float_open(mut self, open: bool) -> Self {
        self.aside_float_open = open;
        self
    }
}

impl gpui::ParentElement for ConversationShell {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// What the column keeps clear of: a docked aside, or a rail from 720px.
fn keep_out(shown: Option<AsideLayout>, rail: rail::Rail, width: f32, ds: &Ds) -> Option<KeepOut> {
    let len = |token| f32::from(ds.len(token));
    let clearance = len(Length::TabRailClearance);
    if shown == Some(AsideLayout::Docked) {
        let keep_out = len(Length::SpaceLg) + column::ASIDE_WIDTH + clearance;
        return Some(KeepOut {
            keep_out,
            clearance,
        });
    }
    if rail.reserved && width >= RAIL_COMPACT {
        let rail_width = if width >= RAIL_FULL {
            Length::TabRailWidth
        } else {
            Length::TabRailCompactWidth
        };
        let keep_out = len(Length::TabRailInset) + len(rail_width) + clearance;
        return Some(KeepOut {
            keep_out,
            clearance,
        });
    }
    None
}

/// The shelf a rail narrower than 720px shows over the messages.
fn rail_top(rail: rail::Rail, width: f32, ds: &Ds) -> f32 {
    if !rail.reserved || width >= RAIL_COMPACT || width <= 0. {
        return 0.;
    }
    let len = |token| f32::from(ds.len(token));
    let touch = len(Length::ControlHitTarget)
        + 2. * len(Length::FocusRingRoom)
        + 2. * len(Length::BorderHairline);
    len(Length::TabRailShelfHeight).max(touch) + len(Length::SpaceSm)
}

impl ConversationShell {
    /// What the transcript, the message list and the jump button read: the column's width and
    /// place (animated as the aside docks or the rail's room comes and goes), and how far the
    /// docked aside still has to ride in.
    fn column_facts(
        &self,
        (width, cards): (f32, bool),
        (shown_aside, rail): (Option<AsideLayout>, rail::Rail),
        window: &mut Window,
        cx: &mut App,
    ) -> (ConversationVars, f32) {
        let ds = Ds::get(cx);
        let hairline = f32::from(ds.len(Length::BorderHairline));
        // The workspace container is the card's box: its border widens it by two hairlines.
        let workspace = width + if cards { 2. * hairline } else { 0. };
        let narrow = Narrow {
            narrow: width > 0.
                && (ds.tokens().viewport.0 <= column::NARROW || workspace <= column::NARROW),
            inset: f32::from(ds.len(if workspace <= column::NARROW {
                Length::SpaceMd
            } else {
                Length::AdaptiveComposerInset
            })),
        };
        let content = column::content_width(width, self.gutter, narrow);
        let (col, target) = column::column(width, content, keep_out(shown_aside, rail, width, ds));
        let glide = Timing::token(ds, DsDuration::MotionSlow, Easing::MotionEaseEmphasized);
        let jump = ds.reduced_motion() || width <= 0.;
        let motion = transition(
            (self.id.clone(), "column-shift"),
            (target, jump),
            &glide,
            window,
            cx,
        );
        let seen = window.use_keyed_state((self.id.clone(), "column-target"), cx, |_, _| target);
        if *seen.read(cx) != target {
            if !jump {
                window.animate_layout(glide.ms());
            }
            seen.update(cx, |value, _| *value = target);
        }
        let shift = motion.target();
        let ds = Ds::get(cx);
        let top_reserve = if cards {
            f32::from(ds.len(Length::SpaceLg))
        } else {
            f32::from(ds.len(Length::TitlebarSafeAreaTop))
        };
        let vars = ConversationVars {
            composer_reserve: self.composer_reserve,
            width,
            column_width: if width > 0. { col } else { 0. },
            column_left: ((width - col) / 2. - shift).max(0.),
            column_shift: shift,
            motion_id: Some(self.id.clone()),
            top_reserve: top_reserve + rail_top(rail, width, ds),
        };
        (vars, target - shift)
    }
}

impl RenderOnce for ConversationShell {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (size, recorder) = measure::track((self.id.clone(), "conversation"), window, cx);
        let width = f32::from(size.width);
        let cards = scope::vars(cx).is_some_and(|vars| vars.cards_docked);
        let layout = aside::layout(&self.id, (self.aside.is_some(), width), window, cx);
        let shown_aside = aside::shown(self.aside.is_some(), layout, self.aside_float_open);
        let has_rail = self.rail.is_some();
        let rail = rail::rail(
            &self.id,
            (has_rail, self.rail_showing, self.rail_view.as_ref()),
            shown_aside.is_some(),
            window,
            cx,
        );
        let (vars, glide) = self.column_facts((width, cards), (shown_aside, rail), window, cx);
        let ds = Ds::get(cx);
        let slot = aside::Slot {
            id: (self.id.clone(), "aside").into(),
            content: self.aside.take(),
            layout,
            float_open: self.aside_float_open,
            top: if cards {
                f32::from(ds.len(Length::SpaceLg))
            } else {
                f32::from(ds.len(Length::TitlebarSafeAreaTop) + ds.len(Length::SpaceSm))
            },
            composer_reserve: self.composer_reserve,
            glide,
        };
        let aside_layers = aside::render(&slot, (width, f32::from(size.height)), window, cx);
        let ds = Ds::get(cx);
        let backdrop = self.background.take().map(|layer| {
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .overflow_hidden()
                .child(layer)
        });
        let rail_layer = self.rail.take().filter(|_| !rail.held).map(|el| {
            rail.release.apply(
                div().child(el),
                &Timing::token(ds, DsDuration::MotionBase, Easing::MotionEaseDecelerate),
                &Props {
                    opacity: Some((0., 1.)),
                    ..Default::default()
                },
            )
        });
        let shell = div()
            .relative()
            .size_full()
            .min_w_0()
            .min_h_0()
            .overflow_hidden()
            .bg(convert::gradient(
                ds.tokens().gradient(GradientToken::ConversationBg),
            ))
            .children(backdrop)
            .child(scope::scoped(
                Spec {
                    conversation: Some(vars),
                    ..Spec::default()
                },
                div()
                    .relative()
                    .size_full()
                    .children(std::mem::take(&mut self.children)),
            ))
            .children(rail_layer)
            .children(aside_layers)
            .child(recorder);
        strut::scope(false, shell)
    }
}
