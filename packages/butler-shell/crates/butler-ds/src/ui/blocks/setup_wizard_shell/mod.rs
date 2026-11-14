//! DS SetupWizardShell (SetupWizardShell.tsx / SetupWizardShell.module.css and its parts): the
//! first-run screen. `Wizard`: the product title, a stepper and a glass body. `Focus`: one
//! centred column on the backdrop, with a card that replaces itself by `step_key`. The backdrop
//! is the riso print still, whatever the user's wallpaper; `backdrop` takes the live wallpaper
//! (P6) in its place.
//!
//! Parts: [`SetupWizardProgress`] (the stepper), [`SetupWizardContent`] and [`SetupWizardList`]
//! (a step's column), [`SetupWizardMark`] (the logo slot) and [`SetupWizardStage`] (the card
//! swap). Not reproduced: the card morph between two solid cards, the first-install ink intro
//! (`SetupWizardIntro::Full` shares the re-run entrance) and its still wash, and the region's
//! accessible name.
mod content;
mod focus;
mod mark;
mod progress;
mod stage;
mod wizard;

use gpui::{
    AnyElement, App, Bounds, ElementId, Global, InteractiveElement as _, IntoElement,
    ParentElement, Pixels, RenderOnce, SharedString, Styled as _, Window, WindowControlArea, div,
};

pub use content::{ContentWidth, SetupWizardContent, SetupWizardList};
pub use mark::SetupWizardMark;
pub use progress::{SetupWizardProgress, SetupWizardStep};
pub use stage::{SetupWizardIntro, SetupWizardStage};

use super::prompt_suggestion_list::ContentRect;
use super::wallpaper::{Wallpaper, WallpaperSource, WallpaperTone, intro_print};
use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::strut;

/// The first-run backdrop, whatever the user's wallpaper. // DS: SetupWizardShell.tsx:22
const SETUP_WALLPAPER: &str = "butler.riso-print";
/// The window width at and below which the screen tightens. // DS: SetupWizardShell.module.css:259
const NARROW_MAX: f32 = 560.;

/// The solid card's window rect as last painted (`[data-setup-card]`, which setupIntro.ts:39-46
/// measures for the intro clock; engine.ts:57 hands it to the wallpaper as `contentRect`). gpui
/// knows a box's place only while painting, so the card records it here.
#[derive(Default)]
struct SetupCard(Option<ContentRect>);

impl Global for SetupCard {}

/// Stores the card's bounds; true when they changed.
pub(super) fn record_card(bounds: Bounds<Pixels>, cx: &mut App) -> bool {
    let next = Some(ContentRect {
        x: f32::from(bounds.left()),
        y: f32::from(bounds.top()),
        width: f32::from(bounds.size.width),
        height: f32::from(bounds.size.height),
    });
    if cx.try_global::<SetupCard>().and_then(|card| card.0) == next {
        return false;
    }
    cx.set_global(SetupCard(next));
    true
}

/// `Wizard`: title, stepper and a glass body. `Focus`: one centred column on the backdrop.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SetupWizardVariant {
    #[default]
    Wizard,
    Focus,
}

/// Focus only. `Center`: the column sits in the middle of the window. `Top`: every screen shares
/// one top edge.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SetupWizardAnchor {
    #[default]
    Center,
    Top,
}

#[derive(IntoElement)]
pub struct SetupWizardShell {
    id: ElementId,
    title: SharedString,
    variant: SetupWizardVariant,
    steps: Vec<SetupWizardStep>,
    active_index: usize,
    window_controls: Option<AnyElement>,
    tone: WallpaperTone,
    embedded: bool,
    anchor: SetupWizardAnchor,
    step_key: Option<SharedString>,
    leaving: Option<AnyElement>,
    intro: Option<SetupWizardIntro>,
    intro_held: bool,
    day_phase: Option<f32>,
    backdrop: Option<AnyElement>,
    children: Vec<AnyElement>,
}

impl SetupWizardShell {
    /// `title` is the visible product title (wizard).
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            variant: SetupWizardVariant::Wizard,
            steps: Vec::new(),
            active_index: 0,
            window_controls: None,
            tone: WallpaperTone::Light,
            embedded: false,
            anchor: SetupWizardAnchor::Center,
            step_key: None,
            leaving: None,
            intro: None,
            intro_held: false,
            day_phase: None,
            backdrop: None,
            children: Vec::new(),
        }
    }

    pub fn variant(mut self, variant: SetupWizardVariant) -> Self {
        self.variant = variant;
        self
    }

    /// Wizard steps; the stepper shows only when steps are given.
    pub fn steps(mut self, steps: impl IntoIterator<Item = SetupWizardStep>) -> Self {
        self.steps = steps.into_iter().collect();
        self
    }

    pub fn active_index(mut self, active_index: usize) -> Self {
        self.active_index = active_index;
        self
    }

    pub fn window_controls(mut self, controls: impl IntoElement) -> Self {
        self.window_controls = Some(controls.into_any_element());
        self
    }

    /// The resolved appearance theme for the wallpaper backdrop.
    pub fn tone(mut self, tone: WallpaperTone) -> Self {
        self.tone = tone;
        self
    }

    /// Contain the layers in the element (DS View previews): the screen sizes to its content.
    pub fn embedded(mut self) -> Self {
        self.embedded = true;
        self
    }

    /// Focus only: where the column sits (default `Center`).
    pub fn anchor(mut self, anchor: SetupWizardAnchor) -> Self {
        self.anchor = anchor;
        self
    }

    /// Focus only: a new key replaces the card (the old one fades out, the new one rises in).
    pub fn step_key(mut self, step_key: impl Into<SharedString>) -> Self {
        self.step_key = Some(step_key.into());
        self
    }

    /// Focus only: the previous step's card, which fades out when `step_key` changes.
    pub fn leaving(mut self, leaving: impl IntoElement) -> Self {
        self.leaving = Some(leaving.into_any_element());
        self
    }

    /// Focus only: how the first card appears.
    pub fn intro(mut self, intro: SetupWizardIntro) -> Self {
        self.intro = Some(intro);
        self
    }

    /// Focus only: the first card waits unseen and the backdrop draws nothing until the host can
    /// show the intro. The card is laid out from the start.
    pub fn intro_held(mut self) -> Self {
        self.intro_held = true;
        self
    }

    /// Local time of day, 0..1 from midnight, for the riso print (`u_dayPhase`; engineDrift.ts:71
    /// reads the clock). The wallpaper's still midday without it.
    pub fn day_phase(mut self, phase: f32) -> Self {
        self.day_phase = Some(phase);
        self
    }

    /// The layer behind the content, in place of the riso print still (the live wallpaper).
    pub fn backdrop(mut self, backdrop: impl IntoElement) -> Self {
        self.backdrop = Some(backdrop.into_any_element());
        self
    }
}

impl ParentElement for SetupWizardShell {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl SetupWizardShell {
    /// The focus column: the children, or the stage that swaps cards by key.
    fn column(&mut self, held: bool, gap: gpui::Pixels) -> AnyElement {
        let children = std::mem::take(&mut self.children);
        if self.step_key.is_none() && self.intro.is_none() {
            return div()
                .w_full()
                .flex()
                .flex_col()
                .items_center()
                .gap(gap)
                .children(children)
                .into_any_element();
        }
        let key = self.step_key.clone().unwrap_or_else(|| "card".into());
        SetupWizardStage::new((self.id.clone(), "stage"), key)
            .intro(self.intro)
            .held(held)
            .leaving(self.leaving.take())
            .children(children)
            .into_any_element()
    }
}

/// The window drag lane over the titlebar band, and the window controls at the top right.
fn chrome(ds: &Ds, controls: Option<AnyElement>) -> (impl IntoElement, Option<impl IntoElement>) {
    let lane = div()
        .absolute()
        .top_0()
        .left_0()
        .w_full()
        .h(ds.len(Length::TitlebarHeight) + ds.len(Length::SpaceMd)) // DS: SetupWizardShell.module.css:35
        .window_control_area(WindowControlArea::Drag);
    let room = ds.len(Length::SpaceSm);
    let controls = controls.map(|controls| div().absolute().top(room).right(room).child(controls));
    (lane, controls)
}

impl SetupWizardShell {
    /// The layer behind the content: the caller's backdrop, else the riso print. With an intro
    /// clock (focus with `intro`) the print keeps its ink off the solid card, as the clock's
    /// card layout does in React (setupIntro.ts:39-46, engine.ts:57); without one it has no
    /// keep-out. // DS: SetupWizardShell.tsx:83,94
    fn backdrop_layer(&mut self, handed_off: bool, cx: &App) -> impl IntoElement {
        let timed = self.variant == SetupWizardVariant::Focus && self.intro.is_some();
        let card = timed
            .then(|| cx.try_global::<SetupCard>().and_then(|card| card.0))
            .flatten();
        let backdrop = self.backdrop.take().unwrap_or_else(|| {
            if self.variant == SetupWizardVariant::Focus
                && matches!(
                    self.intro,
                    Some(SetupWizardIntro::Full | SetupWizardIntro::Rerun)
                )
                && !handed_off
            {
                return intro_print(self.tone, card);
            }
            let wallpaper = Wallpaper::new(WallpaperSource::Live {
                module: SETUP_WALLPAPER.into(),
            })
            .tone(self.tone)
            .content_rect(card);
            let wallpaper = match self.day_phase {
                Some(phase) => wallpaper.day_phase(phase),
                None => wallpaper,
            };
            wallpaper.into_any_element()
        });
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .overflow_hidden()
            .child(backdrop)
    }
}

impl RenderOnce for SetupWizardShell {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        // DS: setupIntro.ts stepChanged hands off permanently on the first key change.
        let intro = window.use_keyed_state((self.id.clone(), "intro-handoff"), cx, |_, _| {
            (self.step_key.clone(), false)
        });
        let handed_off = intro.update(cx, |state, _| {
            state.1 |= state.0 != self.step_key;
            state.1
        });
        let ds = Ds::get(cx);
        let focus = self.variant == SetupWizardVariant::Focus;
        let held = focus && self.intro_held;
        let narrow = ds.tokens().viewport.0 <= NARROW_MAX;
        let pad = ds.len(if narrow {
            Length::SpaceLg
        } else {
            Length::Space2xl
        });
        let viewport = ds.len(Length::AdaptiveViewportBlockSize);
        let mut screen = div()
            .relative()
            .overflow_hidden()
            .w_full()
            .bg(ds.color(Color::WorkspaceBg))
            .text_color(ds.color(Color::TextPrimary));
        screen = match (focus, self.embedded) {
            (false, false) => screen.min_h(viewport),
            (false, true) => screen.min_h(ds.len(Length::PageContainerNarrow)),
            (true, false) => screen.h(viewport),
            (true, true) => screen,
        };
        if !focus {
            screen = screen.flex().items_center().justify_center().p(pad);
        }
        if !held {
            screen = screen.child(self.backdrop_layer(handed_off, cx));
        }
        let (drag, controls) = chrome(ds, self.window_controls.take());
        let body = if focus {
            let column = self.column(held, ds.len(Length::SpaceLg));
            focus::body(&self.id, self.anchor, narrow, column, cx)
        } else {
            wizard::body(
                wizard::Wizard {
                    id: self.id.clone(),
                    title: self.title.clone(),
                    steps: std::mem::take(&mut self.steps),
                    active_index: self.active_index,
                    narrow,
                    children: std::mem::take(&mut self.children),
                },
                cx,
            )
        };
        strut::scope(true, screen.child(body).child(drag).children(controls))
    }
}
