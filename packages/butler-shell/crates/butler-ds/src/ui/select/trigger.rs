//! The Select triggers (Select.module.css `.trigger`): SelectTrigger, a field-like button with the
//! value and a chevron, and SelectPillTrigger, a glass pill. Both open the list when pressed (on
//! the way down), on Enter, Space, Up or Down, and typeahead on the closed trigger changes the
//! value. SelectButton, a plain button styled the same, serves custom popovers.
use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement as _, MouseButton, ParentElement as _,
    SharedString, Styled as _, div,
};

use super::entry::{Row, SelectContent};
use super::{Select, keys};
use crate::tokens::Length;
use crate::ui::context::Ds;
use crate::ui::icon::IconSize;
use crate::ui::menu::TriggerBox;
use crate::ui::pill_button::{PillButton, Surface};
use crate::ui::select_button::{SelectButton, Size};

/// `SelectTrigger`: `size` and the placeholder `SelectValue` shows while nothing is chosen.
pub struct SelectTrigger {
    id: SharedString,
    size: Size,
    placeholder: SharedString,
}

impl SelectTrigger {
    pub fn new(id: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            size: Size::Default,
            placeholder: SharedString::default(),
        }
    }

    pub fn size(mut self, size: Size) -> Self {
        self.size = size;
        self
    }

    pub fn placeholder(mut self, text: impl Into<SharedString>) -> Self {
        self.placeholder = text.into();
        self
    }
}

/// `SelectPillTrigger`: a glass PillButton with an optional glyph and the value.
pub struct SelectPillTrigger {
    id: SharedString,
    icon: Option<crate::ui::Icon>,
    placeholder: SharedString,
}

impl SelectPillTrigger {
    pub fn new(id: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            icon: None,
            placeholder: SharedString::default(),
        }
    }

    pub fn icon(mut self, icon: crate::ui::Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn placeholder(mut self, text: impl Into<SharedString>) -> Self {
        self.placeholder = text.into();
        self
    }
}

/// What `SelectValue` shows: the chosen item's glyph and label, else the placeholder.
struct Shown {
    label: SharedString,
    placeholder: bool,
    glyph: Option<super::entry::Icon>,
}

fn shown(rows: &[Row], value: Option<&SharedString>, placeholder: &SharedString) -> Shown {
    let chosen = rows.iter().find_map(|row| match row {
        Row::Item {
            value: v,
            label,
            icon,
            ..
        } if Some(v) == value => Some((label.clone(), icon.clone())),
        _ => None,
    });
    match chosen {
        Some((label, glyph)) => Shown {
            label,
            placeholder: false,
            glyph,
        },
        None => Shown {
            label: placeholder.clone(),
            placeholder: true,
            glyph: None,
        },
    }
}

/// `valueWithIcon`: the glyph, then the text, `--space-sm` apart.
fn with_glyph(shown: &Shown, ds: &Ds) -> AnyElement {
    let slot = shown.glyph.as_ref().map(|make| {
        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .w(ds.len(Length::IconSizeMd))
            .h(ds.len(Length::IconSizeMd))
            .child(make())
    });
    div()
        .flex()
        .items_center()
        .gap(ds.len(Length::SpaceSm))
        .children(slot)
        .child(shown.label.clone())
        .into_any_element()
}

impl Select {
    /// The trigger, as wide as its container. `content` supplies the labels of the values.
    pub fn trigger(&self, trigger: SelectTrigger, content: &SelectContent, cx: &App) -> AnyElement {
        let rows = std::rc::Rc::new(content.rows());
        let shown = shown(&rows, self.selected(cx).as_ref(), &trigger.placeholder);
        let mut button = SelectButton::new(trigger.id).size(trigger.size);
        if shown.placeholder {
            button = button.placeholder();
        }
        if self.disabled {
            button = button.disabled();
        }
        button = if shown.glyph.is_some() {
            button.child(with_glyph(&shown, Ds::get(cx)))
        } else {
            button.text(shown.label.clone())
        };
        self.wrap(true, rows, button.into_any_element())
    }

    /// A glass pill trigger, as wide as its content.
    pub fn pill_trigger(
        &self,
        trigger: SelectPillTrigger,
        content: &SelectContent,
        cx: &App,
    ) -> AnyElement {
        let rows = std::rc::Rc::new(content.rows());
        let shown = shown(&rows, self.selected(cx).as_ref(), &trigger.placeholder);
        let ds = Ds::get(cx);
        let mut pill = PillButton::new(trigger.id)
            .surface(Surface::Glass)
            .text(shown.label.clone());
        if let Some(glyph) = trigger.icon {
            pill = pill.icon(crate::ui::icon::icon(glyph, IconSize::Sm, ds));
        }
        if self.disabled {
            pill = pill.disabled();
        }
        self.wrap(false, rows, pill.into_any_element())
    }

    /// A trigger that is the caller's own control (`ComposerSelectControl`), as wide as it is.
    pub fn control_trigger(&self, control: AnyElement, content: &SelectContent) -> AnyElement {
        let boxed = div().flex().child(control).into_any_element();
        self.wrap(false, std::rc::Rc::new(content.rows()), boxed)
    }

    fn wrap(&self, fill: bool, rows: std::rc::Rc<Vec<Row>>, child: AnyElement) -> AnyElement {
        let (press, typing, focus) = (self.clone(), self.clone(), self.trigger_focus.clone());
        let inner = div()
            .relative()
            .child(child)
            .child(self.parts.trigger.probe());
        let inner = if fill { inner.w_full() } else { inner };
        let mut boxed = TriggerBox::new(inner.into_any_element(), move |wrapper| {
            wrapper
                .track_focus(&focus)
                .tab_stop(false)
                .capture_any_mouse_down(move |event, window, cx| {
                    if event.button == MouseButton::Left
                        && !event.modifiers.control
                        && !press.disabled
                    {
                        press.rt.update(cx, |rt, _| rt.press(event.position));
                        press.set_open(true, window, cx);
                    }
                })
                .on_key_down(move |event, window, cx| {
                    if typing.disabled || typing.is_open(cx) {
                        return;
                    }
                    if typing.trigger_key(&rows, event, window, cx) {
                        cx.stop_propagation();
                    }
                })
        });
        if fill {
            boxed = boxed.fill();
        }
        boxed.into_any_element()
    }

    /// Typeahead on the closed trigger moves the value; Enter, Space, Up and Down open the list
    /// (Space only when no search runs).
    fn trigger_key(
        &self,
        rows: &std::rc::Rc<Vec<Row>>,
        event: &gpui::KeyDownEvent,
        window: &mut gpui::Window,
        cx: &mut App,
    ) -> bool {
        let keystroke = &event.keystroke;
        let mods = keystroke.modifiers;
        let now = cx.background_executor().now();
        let searching = self.rt.read(cx).trigger_searching(now);
        let mut used = false;
        if let Some(text) = keys::typed(keystroke)
            && crate::ui::overlay::roving::is_search_key(
                &text,
                mods.control,
                mods.alt,
                mods.platform,
            )
        {
            let current = self
                .selected(cx)
                .and_then(|value| super::surface::index_of(rows, &value));
            let labels = keys::enabled(rows);
            let next = self
                .rt
                .update(cx, |rt, _| rt.trigger_search(&text, now, &labels, current));
            let value = next.and_then(|idx| {
                rows.iter().find_map(|row| match row {
                    Row::Item { idx: i, value, .. } if *i == idx => Some(value.clone()),
                    _ => None,
                })
            });
            if let Some(value) = value {
                self.change(value, window, cx);
            }
            used = true;
        }
        let key = keystroke.key.as_str();
        if matches!(key, "enter" | "space" | "up" | "down") && !(searching && key == "space") {
            self.set_open(true, window, cx);
            used = true;
        }
        used
    }
}
