//! A scope owns one selection across its text runs in reading order.
//! Nested scopes join the outer scope; excluded children register no runs.
//! Runs rebuild their layouts and hitboxes during each prepaint.
//! Pointer positions clamp to the scope; highlights paint behind glyphs.
//! One active scope per window copies plain text with block separators.
mod hit;
mod run;
pub use run::Run;

use super::context::Ds;
use crate::tokens::Color;
use gpui::{
    AnyElement, App, Bounds, ClipboardItem, Element, ElementId, Entity, FocusHandle,
    GlobalElementId, Hitbox, HitboxBehavior, Hsla, InspectorElementId, IntoElement, KeyDownEvent,
    LayoutId, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, SharedString,
    TextLayout, WeakEntity, Window,
};

/// The break before a run of text when copied (Chromium's plain-text serialization, measured).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Break {
    None,
    Space,
    Tab,
    Line,
    Paragraph,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Pos {
    run: usize,
    offset: usize,
}

struct RunInfo {
    layout: TextLayout,
    text: SharedString,
    lead: Break,
    space_before: Pixels,
    space_after: Pixels,
    hitbox: Hitbox,
}

pub struct State {
    focus: FocusHandle,
    anchor: Option<Pos>,
    head: Option<Pos>,
    dragging: bool,
    word: Option<(Pos, Pos)>,
    runs: Vec<RunInfo>,
}

#[derive(Default)]
struct Stack(Vec<Option<Entity<State>>>);
impl gpui::Global for Stack {}
#[derive(Default)]
struct Active(Option<WeakEntity<State>>);
impl gpui::Global for Active {}

fn current(cx: &App) -> Option<Entity<State>> {
    cx.try_global::<Stack>()
        .and_then(|s| s.0.last())
        .cloned()
        .flatten()
}

#[derive(Clone)]
pub struct Selection(Entity<State>);
impl Selection {
    /// The selection state keyed by `id`; its focus handle is created with it.
    pub fn new(id: impl Into<ElementId>, window: &mut Window, cx: &mut App) -> Self {
        Self(window.use_keyed_state(id, cx, |_, cx| State {
            focus: cx.focus_handle(),
            anchor: None,
            head: None,
            dragging: false,
            word: None,
            runs: Vec::new(),
        }))
    }

    /// The selected plain text; None when nothing is selected.
    pub fn text(&self, cx: &App) -> Option<String> {
        self.0.read(cx).text()
    }
}

impl State {
    fn range(&self) -> Option<(Pos, Pos)> {
        let (a, b) = (self.anchor?, self.head?);
        let clamp = |p: Pos| {
            let run = p.run.min(self.runs.len().checked_sub(1)?);
            let offset = if run == p.run {
                p.offset
            } else {
                self.runs[run].text.len()
            };
            Some(Pos {
                run,
                offset: boundary(&self.runs[run].text, offset),
            })
        };
        let (a, b) = (clamp(a)?, clamp(b)?);
        (a != b).then_some((a.min(b), a.max(b)))
    }

    fn text(&self) -> Option<String> {
        let (start, end) = self.range()?;
        let mut out = String::new();
        let mut block = self.runs[..=start.run]
            .iter()
            .rev()
            .find(|r| r.lead >= Break::Tab)
            .map_or(Break::None, |r| r.lead);
        for index in start.run..=end.run {
            let run = &self.runs[index];
            if index > start.run {
                out.push_str(match run.lead {
                    Break::None => "",
                    Break::Space => " ",
                    Break::Tab => "\t",
                    Break::Line | Break::Paragraph if block == Break::Paragraph => "\n\n",
                    Break::Line | Break::Paragraph => "\n",
                });
                if run.lead >= Break::Tab {
                    block = run.lead;
                }
            }
            let s = if index == start.run { start.offset } else { 0 };
            let e = if index == end.run {
                end.offset
            } else {
                run.text.len()
            };
            out.push_str(&run.text[s..e]);
        }
        (!out.is_empty()).then_some(out)
    }

    fn press(&mut self, event: &MouseDownEvent) -> bool {
        let Some(pos) = hit::position(&self.runs, event.position) else {
            return false;
        };
        self.word = None;
        let (anchor, head) = match event.click_count {
            1 if event.modifiers.shift && self.anchor.is_some() => (self.anchor, Some(pos)),
            1 => (Some(pos), Some(pos)),
            2 => {
                let range = hit::word(&self.runs[pos.run].text, pos.offset);
                let ends = (
                    Pos {
                        offset: range.start,
                        ..pos
                    },
                    Pos {
                        offset: range.end,
                        ..pos
                    },
                );
                self.word = Some(ends);
                (Some(ends.0), Some(ends.1))
            }
            _ => {
                let (a, b) = hit::paragraph(&self.runs, pos);
                (Some(a), Some(b))
            }
        };
        self.anchor = anchor;
        self.head = head;
        self.dragging = true;
        true
    }

    fn drag(&mut self, event: &MouseMoveEvent) -> bool {
        let Some(mut head) = hit::position(&self.runs, event.position) else {
            return false;
        };
        let mut anchor = self.anchor;
        if let Some((start, end)) = self.word {
            let range = hit::word(&self.runs[head.run].text, head.offset);
            if head >= start {
                anchor = Some(start);
                head.offset = range.end;
            } else {
                anchor = Some(end);
                head.offset = range.start;
            }
        }
        let changed = self.anchor != anchor || self.head != Some(head);
        self.anchor = anchor;
        self.head = Some(head);
        changed
    }
}

fn boundary(text: &str, offset: usize) -> usize {
    let mut offset = offset.min(text.len());
    while !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

/// The selection fill shared by content and editable fields.
pub fn fill(ds: &Ds) -> Hsla {
    if ds.dark() {
        super::convert::with_alpha(ds.color(Color::Blue04), 0.4)
    } else {
        ds.color(Color::Blue02)
    }
}

/// `child` as a scope; nested scopes join the outer one.
pub fn scope(selection: Selection, child: impl IntoElement) -> impl IntoElement {
    ScopeElement {
        selection: Some(selection),
        child: Some(child.into_any_element()),
    }
}

/// `child` takes no part in any selection.
pub fn exclude(child: impl IntoElement) -> impl IntoElement {
    ScopeElement {
        selection: None,
        child: Some(child.into_any_element()),
    }
}

struct ScopeElement {
    selection: Option<Selection>,
    child: Option<AnyElement>,
}
impl IntoElement for ScopeElement {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl Element for ScopeElement {
    type RequestLayoutState = AnyElement;
    type PrepaintState = Option<Hitbox>;
    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, AnyElement) {
        let mut child = self
            .child
            .take()
            .unwrap_or_else(|| gpui::Empty.into_any_element());
        (child.request_layout(window, cx), child)
    }
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        child: &mut AnyElement,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Hitbox> {
        let outer = self.selection.is_some() && current(cx).is_none();
        if outer && let Some(selection) = &self.selection {
            selection.0.update(cx, |s, _| s.runs.clear());
            window.set_focus_handle(&selection.0.read(cx).focus, cx);
        }
        let push = self.selection.is_none() || outer;
        if push {
            cx.default_global::<Stack>()
                .0
                .push(self.selection.as_ref().map(|s| s.0.clone()));
        }
        child.prepaint(window, cx);
        if push {
            cx.default_global::<Stack>().0.pop();
        }
        outer.then(|| window.insert_hitbox(bounds, HitboxBehavior::Normal))
    }
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        child: &mut AnyElement,
        hitbox: &mut Option<Hitbox>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let push = self.selection.is_none() || hitbox.is_some();
        // Child painting changes the active dispatch node; bind copy to this focused scope first.
        if let Some(selection) = self.selection.as_ref().filter(|_| hitbox.is_some()) {
            let selection = selection.clone();
            window.on_key_event(move |event: &KeyDownEvent, phase, _, cx| {
                let m = event.keystroke.modifiers;
                if phase.bubble()
                    && event.keystroke.key == "c"
                    && m.secondary()
                    && !m.alt
                    && !m.shift
                    && let Some(text) = selection.text(cx)
                {
                    cx.write_to_clipboard(ClipboardItem::new_string(text));
                    cx.stop_propagation();
                }
            });
        }
        if let (Some(selection), Some(hitbox)) = (&self.selection, hitbox) {
            listeners(selection, hitbox.clone(), window, cx);
        }
        if push {
            cx.default_global::<Stack>()
                .0
                .push(self.selection.as_ref().map(|s| s.0.clone()));
        }
        child.paint(window, cx);
        if push {
            cx.default_global::<Stack>().0.pop();
        }
    }
}

fn listeners(selection: &Selection, hitbox: Hitbox, window: &mut Window, cx: &App) {
    let state = selection.0.clone();
    window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
        if !phase.bubble()
            || event.button != MouseButton::Left
            || !hitbox.is_hovered(window)
            || window.default_prevented()
        {
            return;
        }
        if !state.update(cx, |s, _| s.press(event)) {
            return;
        }
        window.focus(&state.read(cx).focus.clone(), cx);
        let previous = cx.default_global::<Active>().0.replace(state.downgrade());
        if let Some(previous) = previous.and_then(|s| s.upgrade()).filter(|s| s != &state) {
            previous.update(cx, |s, cx| {
                s.anchor = None;
                s.head = None;
                cx.notify();
            });
        }
        window.prevent_default();
        state.update(cx, |_, cx| cx.notify());
    });
    if selection.0.read(cx).dragging {
        let state = selection.0.clone();
        window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
            if phase.bubble() {
                state.update(cx, |s, cx| {
                    if s.drag(event) {
                        cx.notify();
                    }
                });
            }
        });
        let state = selection.0.clone();
        window.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
            if phase.bubble() && event.button == MouseButton::Left {
                state.update(cx, |s, _| s.dragging = false);
            }
        });
    }
}
