//! DS Tabs (Tabs.tsx / TabsIndicator.tsx / Tabs.module.css, Radix Tabs): a list of triggers over
//! the active panel. Roving focus with automatic activation: the arrows move focus (Left and Right,
//! Up and Down when vertical, wrapping past disabled tabs), Home and End jump to the ends, and
//! focusing a tab selects it. Only the active panel is mounted; it is a tab stop and enters over
//! `--motion-fast` decelerate. At most one tab bar per screen: SegmentedControl is for in-panel
//! choices.
mod indicator;
mod list;

use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, FocusHandle, InteractiveElement as _, IntoElement,
    ParentElement as _, RenderOnce, SharedString, Styled as _, Window, div, px,
};

pub use list::{ListVariant, TabsList, Trigger};

use crate::tokens::{Duration as DsDuration, Easing, Length};
use crate::ui::context::Ds;
use crate::ui::layout::Space;
use crate::ui::motion::{Timing, Tween};
use crate::ui::{focus, strut};

type Handler = Rc<dyn Fn(&str, &mut Window, &mut App)>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Orientation {
    /// The list above the panels.
    #[default]
    Horizontal,
    /// The list beside the panels.
    Vertical,
}

#[derive(IntoElement)]
pub struct Tabs {
    id: ElementId,
    orientation: Orientation,
    gap: Option<Space>,
    default_value: Option<SharedString>,
    value: Option<SharedString>,
    on_change: Option<Handler>,
    list: Option<TabsList>,
    panels: Vec<(SharedString, AnyElement)>,
}

impl Tabs {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            orientation: Orientation::Horizontal,
            gap: None,
            default_value: None,
            value: None,
            on_change: None,
            list: None,
            panels: Vec::new(),
        }
    }

    pub fn orientation(mut self, orientation: Orientation) -> Self {
        self.orientation = orientation;
        self
    }

    /// The space between the list and its panels (default `--space-3`).
    pub fn gap(mut self, gap: Space) -> Self {
        self.gap = Some(gap);
        self
    }

    /// The tab selected first; the tabs then keep their own selection.
    pub fn default_value(mut self, value: impl Into<SharedString>) -> Self {
        self.default_value = Some(value.into());
        self
    }

    /// A controlled selection: the owner holds the value and sets it from `on_value_change`.
    pub fn value(mut self, value: impl Into<SharedString>) -> Self {
        self.value = Some(value.into());
        self
    }

    pub fn on_value_change(
        mut self,
        handler: impl Fn(&str, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }

    pub fn list(mut self, list: TabsList) -> Self {
        self.list = Some(list);
        self
    }

    /// The panel of tab `value` (TabsContent).
    pub fn panel(mut self, value: impl Into<SharedString>, content: impl IntoElement) -> Self {
        self.panels.push((value.into(), content.into_any_element()));
        self
    }

    /// The accessible name of the list.
    pub fn aria_label(&self) -> Option<&SharedString> {
        self.list.as_ref().map(|list| &list.aria_label)
    }
}

impl RenderOnce for Tabs {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let list = self.list.take().unwrap_or_else(|| TabsList::new(""));
        let first = self.default_value.clone();
        let selected = window.use_keyed_state((self.id.clone(), "value"), cx, move |_, _| {
            first.unwrap_or_default()
        });
        let value = self
            .value
            .clone()
            .unwrap_or_else(|| selected.read(cx).clone());
        let change: Handler = {
            let (selected, outer) = (selected, self.on_change.clone());
            Rc::new(move |next: &str, window, cx| {
                let next = SharedString::from(next.to_owned());
                selected.update(cx, |value, cx| {
                    *value = next.clone();
                    cx.notify();
                });
                if let Some(outer) = &outer {
                    outer(&next, window, cx);
                }
            })
        };
        let vertical = self.orientation == Orientation::Vertical;
        let active = list.triggers.iter().position(|t| t.value == value);
        let handles: Vec<Option<FocusHandle>> = (0..list.triggers.len())
            .map(|i| {
                let id = ElementId::from(SharedString::from(format!("{}-trigger-{i}", self.id)));
                (!list.triggers[i].disabled).then(|| {
                    window
                        .use_keyed_state((id, "focus"), cx, |_, cx| cx.focus_handle())
                        .read(cx)
                        .clone()
                })
            })
            .collect();
        // Focusing a tab selects it (a press focuses it, an arrow key moves focus onto it).
        let focused = handles
            .iter()
            .position(|h| h.as_ref().is_some_and(|h| h.is_focused(window)))
            .filter(|i| active != Some(*i));
        if let Some(i) = focused {
            let (change, next) = (change.clone(), list.triggers[i].value.clone());
            window.defer(cx, move |window, cx| change(&next, window, cx));
        }
        let stop = active
            .filter(|i| handles[*i].is_some())
            .or_else(|| handles.iter().position(Option::is_some))
            .unwrap_or(0);
        let ctx = list::Context {
            id: &self.id,
            vertical,
            active,
            handles: &handles,
            stop,
        };
        let list_el = list.render(&ctx, window, cx);
        let keys = roving(&handles, &list.triggers, vertical, change);
        let panel = self.panel_for(&value, window, cx);
        let ds = Ds::get(cx);
        let gap = self
            .gap
            .map_or_else(|| ds.len(Length::Space3), |gap| gap.px(ds));
        let root = div().flex().min_w_0().w_full().gap(gap);
        let root = if vertical {
            root.flex_row().items_stretch()
        } else {
            root.flex_col()
        };
        root.child(strut::flex_scope(
            !vertical,
            div().on_key_down(keys).child(list_el),
        ))
        .children(panel.map(|panel| strut::flex_scope(!vertical, panel)))
    }
}

impl Tabs {
    /// The active panel: a tab stop with the shared ring, entering over `--motion-fast`.
    fn panel_for(
        &mut self,
        value: &SharedString,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<AnyElement> {
        let at = self.panels.iter().position(|(v, _)| v == value)?;
        let (_, content) = self.panels.swap_remove(at);
        let handle = window
            .use_keyed_state((self.id.clone(), "panel-focus"), cx, |_, cx| {
                cx.focus_handle()
            })
            .read(cx)
            .clone();
        let ds = Ds::get(cx);
        let ring = focus::visible(ds, handle.is_focused(window), false);
        let mut panel = div()
            .id((self.id.clone(), "panel"))
            .track_focus(&focus::tab_stop(&handle, true))
            .min_w_0()
            .rounded(ds.len(Length::RadiusControl))
            .text_color(ds.color(crate::tokens::Color::TextPrimary))
            .text_size(ds.len(Length::FontSize3))
            .line_height(ds.len(Length::TypoBodyLineHeight))
            .child(strut::scope(true, content));
        if ring {
            panel = panel.shadow(focus::shadows(ds));
        }
        if ds.reduced_motion() {
            return Some(panel.into_any_element());
        }
        let timing = Timing::token(ds, DsDuration::MotionFast, Easing::MotionEaseDecelerate);
        let key = ElementId::from(SharedString::from(format!("{}-enter-{value}", self.id)));
        let rise = px(2.); // DS: Tabs.module.css:231
        Some(
            Tween::new(key, panel.relative(), timing, move |el, t| {
                el.top(rise * (1. - t)).opacity(t)
            })
            .into_any_element(),
        )
    }
}

/// The arrow, Home and End keys: focus the target among the enabled tabs.
fn roving(
    handles: &[Option<FocusHandle>],
    triggers: &[Trigger],
    vertical: bool,
    change: Handler,
) -> impl Fn(&gpui::KeyDownEvent, &mut Window, &mut App) + 'static {
    let enabled: Vec<(SharedString, FocusHandle)> = handles
        .iter()
        .zip(triggers)
        .filter_map(|(h, t)| h.clone().map(|h| (t.value.clone(), h)))
        .collect();
    move |event, window, cx| {
        let Some(here) = enabled.iter().position(|(_, h)| h.is_focused(window)) else {
            return;
        };
        let count = enabled.len();
        let (next, previous) = if vertical {
            ("down", "up")
        } else {
            ("right", "left")
        };
        let key = event.keystroke.key.as_str();
        let target = match key {
            k if k == next => (here + 1) % count,
            k if k == previous => (here + count - 1) % count,
            "home" => 0,
            "end" => count - 1,
            _ => return,
        };
        cx.stop_propagation();
        if let Some((value, handle)) = enabled.get(target) {
            window.focus(handle, cx);
            change(value, window, cx);
        }
    }
}
