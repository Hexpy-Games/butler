//! PromptSuggestionCard (PromptSuggestionCard.tsx, `.itemFrame` and `.item` of the CSS): a
//! tinted-glass card that is one button. The ordinal sits on top and the title and description
//! at the foot; hover and keyboard focus brighten the glass and lift it, a press puts it back.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, Div, ElementId, InteractiveElement as _, IntoElement as _,
    MouseButton, ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _,
    Window, div, px,
};

use super::content_rect::{Recording, Slot};
use super::glass;
use super::metrics::Metrics;
use super::text::{Face, run};
use super::{LIFT, PromptSuggestionItem};
use crate::tokens::{Color, Duration as DsDuration, Easing, Length, Number};
use crate::ui::blocks::anim::ramp;
use crate::ui::blocks::measure;
use crate::ui::context::Ds;
use crate::ui::control::{Control, Disabled, DisabledLook, Width};
use crate::ui::motion::Timing;
use crate::ui::typo::{Tone, Typo};
use crate::ui::{convert, focus};

/// The pointer over a card.
#[derive(Clone, Copy, Default)]
struct Pointer {
    over: bool,
    down: bool,
}

pub(super) struct Card<'a> {
    pub id: ElementId,
    pub item: &'a PromptSuggestionItem,
    pub index: usize,
}

/// The ordinal when the item has no meta.
fn meta(card: &Card) -> SharedString {
    card.item
        .meta
        .clone()
        .unwrap_or_else(|| format!("{:02}", card.index + 1).into())
}

/// The card's width: its content's width within the track's range (`minmax(min, max)`).
fn width(card: &Card, m: &Metrics, window: &mut Window, cx: &App) -> f32 {
    let pad = 2. * f32::from(Ds::get(cx).len(Length::Space4));
    let measured = [
        (meta(card), Length::TypoCaptionSize),
        (card.item.title.clone(), Length::TypoH5Size),
        (card.item.description.clone(), Length::TypoBodySize),
    ]
    .iter()
    .map(|(text, size)| measure::text_width(text, *size, window, cx))
    .fold(0., f32::max);
    (pad + measured).clamp(m.cards.0, m.cards.1.max(m.cards.0))
}

/// The ordinal, then the title and description at the card's foot (`.item`'s two rows).
fn content(card: &Card, ds: &Ds, cx: &App) -> Div {
    let caption = Face {
        size: Length::TypoCaptionSize,
        line_height: Length::TypoCaptionLineHeight,
        weight: ds.number(Number::TypoLabelWeight),
        letter_spacing: 0.,
    };
    let ordinal = run(&caption, meta(card), ds, cx)
        // DS: PromptSuggestionList.module.css:263 `color-mix(text-secondary 62%, transparent)`
        .text_color(convert::with_alpha(ds.color(Color::TextSecondary), 0.62));
    let copy = div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .justify_end()
        .gap(ds.len(Length::Space2))
        .child(Typo::h5(card.item.title.clone()).tone(Tone::Primary))
        .child(Typo::body(card.item.description.clone()).tone(Tone::Secondary));
    div()
        .flex()
        .flex_col()
        .self_stretch()
        .w_full()
        .min_w_0()
        .gap(ds.len(Length::Space5))
        .child(ordinal)
        .child(copy)
}

/// The button over the glass: its focus ring is the card's (`.item:focus-visible` draws none
/// of its own; the frame draws it), so the control is the card's size and radius.
fn button(card: &Card, ds: &Ds, cx: &App) -> Control {
    let pad = ds.len(Length::Space4);
    let mut control = Control::new(card.id.clone(), ds);
    control.width = Width::Full;
    control.inline = false;
    control.justify_center = false;
    control.padding = [pad; 4];
    control.radius = ds.len(Length::RadiusPanel);
    control.scale = false;
    control.disabled = if card.item.disabled {
        Disabled::Native
    } else {
        Disabled::No
    };
    control.disabled_look = DisabledLook::Text;
    control.outer = Some(Box::new(gpui::Styled::flex_auto));
    let select = card.item.on_select.clone();
    control.on_click(select.map(|select| {
        Rc::new(move |_: &ClickEvent, window: &mut Window, cx: &mut App| select(window, cx))
            as Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>
    }));
    control.children = vec![content(card, ds, cx).into_any_element()];
    control
}

/// Whether the card's button shows a keyboard focus ring now (`.item:focus-visible`).
fn focus_visible(card: &Card, window: &mut Window, cx: &mut App) -> bool {
    if card.item.disabled {
        return false;
    }
    // The control keeps its focus handle in this state; the card reads the same one.
    let handle = window
        .use_keyed_state((card.id.clone(), "focus"), cx, |_, cx| cx.focus_handle())
        .read(cx)
        .clone();
    focus::visible(Ds::get(cx), handle.is_focused(window), false)
}

/// The glass state eased over `--motion-base`: `(tone, lift)`, and whether the glass is bright.
fn motion(card: &Card, pointer: Pointer, window: &mut Window, cx: &mut App) -> (f32, f32, bool) {
    let bright = !card.item.disabled && (pointer.over || focus_visible(card, window, cx));
    let (timing, reduced) = {
        let ds = Ds::get(cx);
        (
            Timing::token(ds, DsDuration::MotionBase, Easing::MotionEaseStandard),
            ds.reduced_motion(),
        )
    };
    // Reduced motion draws no lift (`.itemFrame:hover { transform: none }`).
    let lifted = bright && !pointer.down && !reduced;
    let tone = ramp(
        (card.id.clone(), "tone"),
        (f32::from(u8::from(bright)), reduced),
        &timing,
        window,
        cx,
    );
    let lift = ramp(
        (card.id.clone(), "lift"),
        (f32::from(u8::from(lifted)), reduced),
        &timing,
        window,
        cx,
    );
    (tone, lift, bright)
}

/// One card.
pub(super) fn render(
    card: &Card,
    m: &Metrics,
    recording: Option<&Recording>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let pointer =
        window.use_keyed_state((card.id.clone(), "pointer"), cx, |_, _| Pointer::default());
    let seen = *pointer.read(cx);
    let (tone, lift, bright) = motion(card, seen, window, cx);
    let card_width = width(card, m, window, cx);
    let ds = Ds::get(cx);
    let lift_px = LIFT * lift;
    let set = |change: fn(&mut Pointer)| {
        let pointer = pointer.clone();
        move |cx: &mut App| {
            pointer.update(cx, |pointer, cx| {
                change(pointer);
                cx.notify();
            });
        }
    };
    let (over, down, up, leave) = (
        set(|p| p.over = true),
        set(|p| p.down = true),
        set(|p| p.down = false),
        set(|p| *p = Pointer::default()),
    );
    let up_out = up.clone();
    div()
        .id((card.id.clone(), "frame"))
        .relative()
        .flex()
        .flex_col()
        .flex_none()
        .w(px(card_width))
        .top(px(-lift_px))
        .on_hover(move |on, _, cx| if *on { over(cx) } else { leave(cx) })
        .on_mouse_down(MouseButton::Left, move |_, _, cx| down(cx))
        .on_mouse_up(MouseButton::Left, move |_, _, cx| up(cx))
        .on_mouse_up_out(MouseButton::Left, move |_, _, cx| up_out(cx))
        .child(glass::layer(ds, bright, tone))
        .child(button(card, ds, cx))
        .children(recording.map(|recording| recording.record(Slot::Card(lift_px))))
        .into_any_element()
}
