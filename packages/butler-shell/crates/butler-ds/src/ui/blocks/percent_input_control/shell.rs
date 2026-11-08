//! What PercentInputControl and TokenInputControl share (both React blocks are the same three
//! parts): a number input, a slider and a caption, over a draft text that the owner's committed
//! value resets. A commit runs when the input loses focus (Enter blurs it), when a slider drag
//! ends and when a key is released on the slider.
use std::cell::RefCell;
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, Entity, Focusable as _, InteractiveElement as _, IntoElement as _,
    MouseButton, ParentElement as _, SharedString, Window, div,
};

use crate::ui::layout::{Space, Stack};
use crate::ui::slider::Slider;
use crate::ui::text::{self, Input};
use crate::ui::typo::Typo;

/// The text in the input, and the value the control last committed.
#[derive(Clone)]
pub(crate) struct Draft {
    pub(crate) text: Entity<SharedString>,
    pub(crate) committed: Entity<f64>,
}

/// Commits the text it is given.
pub(crate) type Commit = Rc<dyn Fn(&str, &Draft, &mut Window, &mut App)>;
type Flush = Rc<dyn Fn(&mut Window, &mut App)>;

pub(crate) struct View {
    pub(crate) id: ElementId,
    pub(crate) min: f64,
    pub(crate) max: f64,
    pub(crate) step: f64,
    pub(crate) disabled: bool,
    /// Where the slider sits: the draft text, parsed and kept in range.
    pub(crate) slider_value: f64,
    pub(crate) caption: String,
}

/// A whole number as the input shows it.
pub(crate) fn show(value: f64) -> SharedString {
    format!("{value:.0}").into()
}

pub(crate) fn set_text(text: &Entity<SharedString>, value: SharedString, cx: &mut App) {
    text.update(cx, |text, cx| {
        *text = value;
        cx.notify();
    });
}

/// The draft of control `id`; a new owner `value` resets it (`useEffect` on `value`).
pub(crate) fn draft(id: &ElementId, value: f64, window: &mut Window, cx: &mut App) -> Draft {
    let key = |name: &'static str| (id.clone(), name);
    let seen = window.use_keyed_state(key("seen"), cx, |_, _| value);
    let text = window.use_keyed_state(key("draft"), cx, |_, _| show(value));
    let committed = window.use_keyed_state(key("committed"), cx, |_, _| value);
    if (*seen.read(cx) - value).abs() > f64::EPSILON {
        seen.update(cx, |seen, _| *seen = value);
        text.update(cx, |text, _| *text = show(value));
        committed.update(cx, |committed, _| *committed = value);
    }
    Draft { text, committed }
}

/// The input over the slider over the caption.
pub(crate) fn view(
    v: View,
    draft: &Draft,
    commit: Commit,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let flush: Flush = {
        let draft = draft.clone();
        Rc::new(move |window, cx| {
            let raw = draft.text.read(cx).to_string();
            commit(&raw, &draft, window, cx);
        })
    };
    blur_commits(&v.id, &flush, window, cx);
    let typed = draft.text.clone();
    let mut input = Input::new(v.id.clone())
        .value(draft.text.read(cx).clone())
        .on_change(move |text, _, cx| set_text(&typed, text.to_owned().into(), cx));
    let dragged = draft.text.clone();
    let mut slider = Slider::new((v.id.clone(), "slider"), v.slider_value, v.min, v.max)
        .step(v.step)
        .on_value_change(move |next, _, cx| set_text(&dragged, show(next), cx));
    if v.disabled {
        input = input.disabled();
        slider = slider.disabled();
    }
    Stack::new()
        .gap(Space::Sm)
        .child(
            div()
                .on_key_down(|event, window, cx| {
                    if event.keystroke.key == "enter" {
                        window.blur(cx);
                    }
                })
                .child(input),
        )
        .child(slider_commits(slider, &v.id, flush, window, cx))
        .child(Typo::caption(v.caption))
        .into_any_element()
}

/// The input commits when it loses focus. One subscription lives as long as the control; it
/// runs the latest `flush`.
fn blur_commits(id: &ElementId, flush: &Flush, window: &mut Window, cx: &mut App) {
    type Slot = Rc<RefCell<Option<Flush>>>;
    let slot = window
        .use_keyed_state((id.clone(), "flush"), cx, |_, _| Slot::default())
        .read(cx)
        .clone();
    *slot.borrow_mut() = Some(flush.clone());
    let handle = text::state(id.clone(), window, cx)
        .read(cx)
        .focus_handle(cx);
    window.use_keyed_state((id.clone(), "blur"), cx, move |window, cx| {
        window.on_focus_out(&handle, cx, move |_, window, cx| {
            let flush = slot.borrow().clone();
            if let Some(flush) = flush {
                flush(window, cx);
            }
        })
    });
}

/// The slider commits where a drag ends (wherever the pointer is) and when a key comes up on it.
/// A release counts only after a press on the slider.
fn slider_commits(
    slider: Slider,
    id: &ElementId,
    flush: Flush,
    window: &mut Window,
    cx: &mut App,
) -> gpui::Div {
    let pressed = window.use_keyed_state((id.clone(), "pressed"), cx, |_, _| false);
    let release = {
        let (pressed, flush) = (pressed.clone(), flush.clone());
        move |_: &gpui::MouseUpEvent, window: &mut Window, cx: &mut App| {
            let was_pressed = pressed.update(cx, |pressed, _| std::mem::take(pressed));
            if was_pressed {
                flush(window, cx);
            }
        }
    };
    div()
        .on_mouse_down(MouseButton::Left, move |_, _, cx| {
            pressed.update(cx, |pressed, _| *pressed = true);
        })
        .on_mouse_up(MouseButton::Left, release.clone())
        .on_mouse_up_out(MouseButton::Left, release)
        .on_key_up(move |_, window, cx| flush(window, cx))
        .child(slider)
}
