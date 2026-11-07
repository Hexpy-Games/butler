//! The private composition the question and decision panels share (lib/composerPanel.tsx and
//! composerPanel.module.css): a frame, a subject header with an icon, an eyebrow, the title and
//! an aside, a scrolling body and an actions row. `composer` placement sits in place of the
//! composer input; `conversation` sits in the transcript inside a flat bordered Card.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, KeyDownEvent, ParentElement,
    Pixels, SharedString, Styled as _, Window, div, px,
};

use crate::tokens::{Color, Duration as DsDuration, Easing, Length};
use crate::ui::card::{Card, CardPadding, CardRadius};
use crate::ui::context::Ds;
use crate::ui::icon_slot::{IconSlot, SlotSize, SlotTone};
use crate::ui::motion::Timing;
use crate::ui::scroll::{MaxHeight, ScrollArea};
use crate::ui::typo::{Tone, Typo};
use crate::ui::{focus, strut};

/// Where a question or decision panel sits.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Placement {
    /// In place of the composer input, inside ComposerCard.
    #[default]
    Composer,
    /// In the transcript, inside its own flat bordered `Card radius="lg"` with control-radius
    /// buttons.
    Conversation,
}

impl Placement {
    /// `--composer-panel-inset`.
    pub fn inset(self, ds: &Ds) -> Pixels {
        ds.len(match self {
            Self::Composer => Length::SpaceLg,
            Self::Conversation => Length::SpaceMd,
        })
    }

    /// `--composer-panel-body-inset`.
    fn body_inset(self, ds: &Ds) -> Pixels {
        ds.len(match self {
            Self::Composer => Length::SpaceSm,
            Self::Conversation => Length::SpaceXs,
        })
    }

    /// `--composer-panel-actions-inset`.
    fn actions_inset(self, ds: &Ds) -> Pixels {
        ds.len(match self {
            Self::Composer => Length::SpaceSm,
            Self::Conversation => Length::SpaceMd,
        })
    }

    /// `--composer-panel-button-radius`.
    pub fn button_radius(self, ds: &Ds) -> Pixels {
        ds.len(match self {
            Self::Composer => Length::AdaptiveComposerRadius,
            Self::Conversation => Length::RadiusControl,
        })
    }

    fn radius(self, ds: &Ds) -> Pixels {
        self.button_radius(ds)
    }
}

/// How far the panel has left (0 shown, 1 gone): the exit the decision and question panels run
/// before the caller replaces them (`useComposerPanelTransition`).
pub fn exit_progress(
    id: impl Into<ElementId>,
    leaving: bool,
    window: &mut Window,
    cx: &mut App,
) -> f32 {
    let ds = Ds::get(cx);
    let timing = Timing::token(ds, DsDuration::MotionExitBase, Easing::MotionEaseAccelerate);
    let jump = ds.reduced_motion();
    crate::ui::blocks::anim::ramp(
        (id.into(), "exit"),
        (if leaving { 1. } else { 0. }, jump),
        &timing,
        window,
        cx,
    )
}

/// The key handler: the event, whether the frame itself has focus.
type KeyHandler = Rc<dyn Fn(&KeyDownEvent, bool, &mut Window, &mut App)>;

/// The frame's key handling and focus, as the panel decides them.
pub struct FrameKeys {
    pub id: ElementId,
    /// The key and whether the frame itself (not a control in it) has focus.
    pub on_key: KeyHandler,
}

/// The surface: the panel's content in its placement. `leaving` is [`exit_progress`].
pub fn frame(
    placement: Placement,
    keys: FrameKeys,
    leaving: f32,
    content: AnyElement,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let handle = window
        .use_keyed_state((keys.id.clone(), "focus"), cx, |_, cx| cx.focus_handle())
        .read(cx)
        .clone();
    let ds = Ds::get(cx);
    let focused = focus::visible(ds, handle.is_focused(window), false);
    let radius = placement.radius(ds);
    let sm = ds.len(Length::SpaceSm);
    let on_key = keys.on_key;
    let own = handle.clone();
    let mut surface = div()
        .id(keys.id.clone())
        .track_focus(&focus::tab_stop(&handle, true))
        .on_key_down(move |event, window, cx| {
            let own = own.is_focused(window);
            on_key(event, own, window, cx);
        })
        .relative()
        .min_w_0()
        .rounded(radius)
        .opacity(1. - leaving)
        .top(sm * leaving)
        .child(content);
    if focused {
        surface = surface.child(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .rounded(radius)
                .border(ds.len(Length::FocusRingWidth))
                .border_color(ds.color(Color::ColorActionPrimary)),
        );
    }
    match placement {
        Placement::Composer => surface.into_any_element(),
        Placement::Conversation => Card::new((keys.id, "card"))
            .padding(CardPadding::None)
            .radius(CardRadius::Lg)
            .child(strut::grid_scope(surface))
            .into_any_element(),
    }
}

/// What the subject row holds.
pub struct Subject {
    pub icon: AnyElement,
    pub eyebrow: Option<SharedString>,
    pub title: AnyElement,
    pub aside: Option<AnyElement>,
    /// A tab row sits above: the row takes `--space-md` of block padding.
    pub tabbed: bool,
    /// Something follows the subject before the actions (details, an option list).
    pub has_body: bool,
}

/// `ComposerPanelHeader`: the icon, the eyebrow over the title, and the aside at the end.
pub fn header(subject: Subject, placement: Placement, ds: &Ds) -> AnyElement {
    let inset = placement.inset(ds);
    let (top, bottom) = if subject.tabbed {
        (ds.len(Length::SpaceMd), ds.len(Length::SpaceMd))
    } else if subject.has_body {
        (inset, ds.len(Length::SpaceXs))
    } else {
        (inset, ds.len(Length::SpaceSm))
    };
    let caption_line = ds.len(Length::TypoCaptionLineHeight);
    let icon = div()
        .flex_none()
        .text_size(ds.len(Length::TypoCaptionSize))
        .line_height(caption_line)
        .child(
            IconSlot::new()
                .size(SlotSize::Sm)
                .min_line()
                .tone(SlotTone::Secondary)
                .child(subject.icon),
        );
    let heading = div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .children(
            subject
                .eyebrow
                .map(|text| Typo::caption(text).tone(Tone::Tertiary)),
        )
        .child(subject.title);
    let aside = subject.aside.map(|aside| {
        div()
            .flex()
            .flex_none()
            .items_baseline()
            .gap(ds.len(Length::SpaceSm))
            .text_size(ds.len(Length::TypoCaptionSize))
            .line_height(caption_line)
            .child(aside)
    });
    div()
        .flex()
        .items_start()
        .gap(ds.len(Length::SpaceSm))
        .min_w_0()
        .px(inset)
        .pt(top)
        .pb(bottom)
        .child(icon)
        .child(heading)
        .children(aside)
        .into_any_element()
}

/// `ComposerPanelBody`: the content in a scroller capped at `--scroll-area-max-height-xs`.
pub fn body(
    id: impl Into<ElementId>,
    single: bool,
    content: AnyElement,
    placement: Placement,
    ds: &Ds,
) -> AnyElement {
    let inset = placement.body_inset(ds);
    let xs = ds.len(Length::SpaceXs);
    // `.singleContent { padding-block-start: var(--space-xs) }` replaces the scroll area's edge
    // padding (the fade size) at the top.
    let top = if single {
        xs - ds.len(Length::ScrollFadeSize)
    } else {
        px(0.)
    };
    div()
        .min_w_0()
        .px(inset)
        .pb(inset)
        .child(
            ScrollArea::new(id)
                .max_height(MaxHeight::Xs)
                .child(div().mt(top).child(div().p(xs).child(content))),
        )
        .into_any_element()
}

/// `ComposerPanelActions`: a wrapping row of buttons at the end, over a divider.
pub fn actions(children: Vec<AnyElement>, placement: Placement, ds: &Ds) -> AnyElement {
    div()
        .flex()
        .flex_wrap()
        .items_center()
        .justify_end()
        .min_w_0()
        .gap(ds.len(Length::SpaceSm))
        .p(placement.actions_inset(ds))
        .border_t(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::ComposerGlassDivider))
        .children(children)
        .into_any_element()
}
