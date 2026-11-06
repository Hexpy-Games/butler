//! DS Select (shadcn/ui/select.tsx over Radix Select): a modal list of options. The trigger
//! opens it when pressed (on the way down) or on Enter, Space, Up or Down, and typeahead on the
//! closed trigger changes the value. Open, the page is scroll-locked and outside pointer events
//! are blocked, Tab is prevented and Escape closes; the selected item (else the first) is
//! highlighted, Up, Down, Home, End and typeahead move the highlight, Enter or Space selects.
//! Item-aligned positioning lays the list over the trigger; `position = popper` places it below
//! like a popover. Press, drag and release selects the item under the release, unless the
//! pointer hardly moved from the press that opened the list.
mod aligned;
mod entry;
mod keys;
mod runtime;
mod surface;
mod trigger;

use std::rc::Rc;

use gpui::{
    AnyElement, App, Entity, FocusHandle, IntoElement as _, ParentElement as _, SharedString,
    Styled as _, Window, div, point, px,
};

pub use entry::{Entry, Position, SelectContent, SelectGroup, SelectItem};
pub use trigger::{SelectPillTrigger, SelectTrigger};

use entry::Row;
use runtime::Rt;

use crate::ui::bottom_sheet::SheetState;
use crate::ui::bottom_sheet::present::{self, Presented};
use crate::ui::context::Ds;
use crate::ui::layer::{Layer, Z};
use crate::ui::menu::footprint;
use crate::ui::overlay::dismiss::{Dismissable, Handle, Reason};
use crate::ui::overlay::lifecycle::{Lifecycle, Phase, Spec};
use crate::ui::overlay::motion::{self, Motion};
use crate::ui::overlay::place::{Options, Rect, Side};
use crate::ui::overlay::popper::{Anchor, Output, Popper};
use crate::ui::overlay::scope::Scope;
use crate::ui::overlay::scrim;
use crate::ui::overlay::theme::Theme;

type ValueChange = Rc<dyn Fn(SharedString, &mut Window, &mut App)>;

/// Who owns the value.
#[derive(Clone, PartialEq)]
enum Control {
    /// The Select keeps it (`defaultValue`).
    Own,
    /// The caller does (`value`).
    Value(Option<SharedString>),
}

/// The measured rectangles the list is laid out from.
#[derive(Clone, Default)]
struct Parts {
    trigger: Anchor,
    content: Anchor,
    viewport: Anchor,
    item: Anchor,
    text: Anchor,
    output: Output,
}

/// A Select's runtime: state owned by the keyed states of its id.
#[derive(Clone)]
pub struct Select {
    id: SharedString,
    open: Entity<bool>,
    value: Entity<Option<SharedString>>,
    seeded: Entity<bool>,
    life: Entity<Lifecycle>,
    scope: Entity<Scope>,
    rt: Entity<Rt>,
    sheet: Entity<SheetState>,
    parts: Parts,
    trigger_focus: FocusHandle,
    controlled: Control,
    disabled: bool,
    on_value_change: Option<ValueChange>,
    theme: Theme,
}

fn rect(bounds: gpui::Bounds<gpui::Pixels>) -> Rect {
    Rect {
        left: f32::from(bounds.origin.x),
        top: f32::from(bounds.origin.y),
        width: f32::from(bounds.size.width),
        height: f32::from(bounds.size.height),
    }
}

impl Select {
    pub fn new(id: impl Into<SharedString>, window: &mut Window, cx: &mut App) -> Self {
        let id: SharedString = id.into();
        let key: gpui::ElementId = id.clone().into();
        let parts = window
            .use_keyed_state((key.clone(), "parts"), cx, |_, _| Parts::default())
            .read(cx)
            .clone();
        Self {
            open: window.use_keyed_state((key.clone(), "open"), cx, |_, _| false),
            value: window.use_keyed_state((key.clone(), "value"), cx, |_, _| None),
            seeded: window.use_keyed_state((key.clone(), "seeded"), cx, |_, _| false),
            life: window.use_keyed_state((key.clone(), "life"), cx, |_, _| Lifecycle::default()),
            scope: window.use_keyed_state((key.clone(), "scope"), cx, |_, cx| Scope::new(cx)),
            rt: window.use_keyed_state((key.clone(), "runtime"), cx, |_, _| Rt::default()),
            sheet: window.use_keyed_state((key.clone(), "sheet"), cx, |_, _| SheetState::default()),
            trigger_focus: window
                .use_keyed_state((key, "trigger-focus"), cx, |_, cx| cx.focus_handle())
                .read(cx)
                .clone(),
            id,
            parts,
            controlled: Control::Own,
            disabled: false,
            on_value_change: None,
            theme: Theme::current(cx),
        }
    }

    /// The value before anything is chosen (uncontrolled).
    pub fn default_value(self, value: impl Into<SharedString>, cx: &mut App) -> Self {
        if !*self.seeded.read(cx) {
            self.seeded.update(cx, |seeded, _| *seeded = true);
            let value = value.into();
            self.value.update(cx, |current, _| *current = Some(value));
        }
        self
    }

    /// Controlled: the caller owns the value and hears changes in `on_value_change`.
    pub fn value(mut self, value: Option<SharedString>) -> Self {
        self.controlled = Control::Value(value);
        self
    }

    pub fn on_value_change(
        mut self,
        handler: impl Fn(SharedString, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_value_change = Some(Rc::new(handler));
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    /// Opens the list: a NativeSelect's stand-in on a platform with no OS popup menu.
    pub(crate) fn open(&self, window: &mut Window, cx: &mut App) {
        self.set_open(true, window, cx);
    }

    /// A zero-cost layer that measures the element it is placed in as the trigger's box.
    pub(crate) fn trigger_probe(&self) -> gpui::Div {
        self.parts.trigger.probe()
    }

    pub fn is_open(&self, cx: &App) -> bool {
        *self.open.read(cx)
    }

    /// The chosen value, if any.
    pub fn selected(&self, cx: &App) -> Option<SharedString> {
        match &self.controlled {
            Control::Value(value) => value.clone(),
            Control::Own => self.value.read(cx).clone(),
        }
    }

    fn set_open(&self, open: bool, window: &mut Window, cx: &mut App) {
        self.open.update(cx, |state, cx| {
            *state = open;
            cx.notify();
        });
        window.refresh();
    }

    /// Chooses `value` and closes the list.
    fn choose(&self, value: SharedString, window: &mut Window, cx: &mut App) {
        self.change(value, window, cx);
        self.set_open(false, window, cx);
    }

    fn change(&self, value: SharedString, window: &mut Window, cx: &mut App) {
        if self.controlled == Control::Own {
            self.value.update(cx, |current, cx| {
                *current = Some(value.clone());
                cx.notify();
            });
        }
        if let Some(handler) = &self.on_value_change {
            handler(value, window, cx);
        }
        window.refresh();
    }

    /// Where item-aligned positioning puts the list: measured on the frame after the list
    /// first showed (it is not painted until then), and measured once more when the first
    /// scroll button appears (Radix repositions then).
    fn place(&self, window: &Window, cx: &mut App) -> Option<aligned::Geometry> {
        let (current, rescued, buttons, scroll, offset) = {
            let rt = self.rt.read(cx);
            (
                rt.geometry,
                rt.rescued,
                rt.buttons,
                rt.scroll.clone(),
                rt.scroll_buttons(),
            )
        };
        if current.is_some() && (rescued || buttons == offset) {
            return current;
        }
        let p = &self.parts;
        let (Some(trigger), Some(content), Some(viewport), Some(item), Some(text)) = (
            p.trigger.bounds(),
            p.content.bounds(),
            p.viewport.bounds(),
            p.item.bounds(),
            p.text.bounds(),
        ) else {
            return current;
        };
        let ds = Ds::get(cx);
        let viewport = rect(viewport);
        // The list is the scrolled content of the viewport.
        let list = Rect {
            top: viewport.top + f32::from(scroll.offset().y),
            height: viewport.height + f32::from(scroll.max_offset().y),
            ..viewport
        };
        let measured = aligned::Measured {
            content: rect(content),
            viewport,
            list,
            item: rect(item),
            text_left: f32::from(text.origin.x),
            border: f32::from(ds.len(crate::tokens::Length::BorderHairline)),
            padding: surface::PADDING,
        };
        let size = window.viewport_size();
        let trigger = rect(trigger);
        let target = aligned::Target {
            trigger,
            value_left: trigger.left + crate::ui::select_button::value_inset(ds),
            window: (f32::from(size.width), f32::from(size.height)),
        };
        let geometry = aligned::place(&measured, &target);
        self.rt.update(cx, |rt, _| {
            rt.rescued = rt.geometry.is_some();
            rt.buttons = offset;
            rt.geometry = Some(geometry);
            // Pinned to the top margin, the list scrolls so the chosen item meets the trigger.
            if let Some(top) = geometry.scroll_top {
                rt.scroll.set_offset(point(px(0.), px(-top)));
            }
        });
        Some(geometry)
    }

    /// The list, in the top layer while open.
    pub fn content(
        &self,
        content: &SelectContent,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let open = self.is_open(cx);
        let rows = Rc::new(content.rows());
        let selected = self
            .selected(cx)
            .and_then(|value| surface::index_of(&rows, &value));
        let start = selected.or_else(|| surface::first_enabled(&rows));
        self.rt.update(cx, |rt, _| rt.begin(open, start));
        let spec = Spec {
            modal: true,
            parent: None,
        };
        // Radix Select unmounts at once: no exit.
        let synced = Lifecycle::sync(
            &self.life,
            open,
            &spec,
            &self.parts.output,
            std::time::Duration::ZERO,
            window,
            cx,
        );
        self.scope.update(cx, |scope, cx| {
            scope.sync(open, true, true, window, cx);
        });
        if synced.phase == Phase::Closed {
            return footprint(div());
        }
        let Some(handle) = synced.handle else {
            return footprint(div());
        };
        let width = f32::from(window.viewport_size().width);
        if content.presentation.unwrap_or_default().is_sheet(width) {
            let layers = self.sheet_layers(
                content,
                &rows,
                start,
                selected,
                synced.phase,
                &handle,
                window,
                cx,
            );
            return footprint(layers);
        }
        let layer = self.layer(
            content,
            &rows,
            start,
            selected,
            synced.phase,
            &handle,
            window,
            cx,
        );
        footprint(div().child(scrim(Z::Popover, window)).child(layer))
    }

    /// The BottomSheet presentation: the viewport of rows in the sheet's body under its backdrop.
    /// Radix Select has no exit, so the backdrop leaves with the list.
    #[expect(
        clippy::too_many_arguments,
        reason = "one layer's inputs: the content, where it starts, its handle and the window"
    )]
    fn sheet_layers(
        &self,
        content: &SelectContent,
        rows: &Rc<Vec<Row>>,
        start: Option<usize>,
        selected: Option<usize>,
        phase: Phase,
        handle: &Handle,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let theme = content.theme.unwrap_or(self.theme);
        let focus = self.scope.read(cx).handle.clone();
        let view = surface::View {
            rows,
            value: self.selected(cx),
            start,
            selected,
            geometry: None,
            popper: true,
        };
        let body = theme.scoped(cx, |cx| surface::build_sheet(self, &view, &focus, cx));
        let select = self.clone();
        Presented {
            grabber: present::decorative_handle(&self.id, &self.sheet),
            id: self.id.clone(),
            phase,
            handle: Some(handle.clone()),
            theme,
            state: self.sheet.clone(),
            focus,
            scope: None,
            title: None,
            expandable: None,
            content: vec![body],
            selector: "select-content",
            on_dismiss: Rc::new(move |reason, window, cx| {
                // Radix Select prevents the focus-outside dismissal: the list holds focus.
                if reason != Reason::FocusOutside {
                    select.set_open(false, window, cx);
                }
            }),
        }
        .layers(window, cx)
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "one layer's inputs: the content, where it starts, its phase and the window"
    )]
    fn layer(
        &self,
        content: &SelectContent,
        rows: &Rc<Vec<Row>>,
        start: Option<usize>,
        selected: Option<usize>,
        phase: Phase,
        handle: &Handle,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let theme = content.theme.unwrap_or(self.theme);
        let focus = self.scope.read(cx).handle.clone();
        let aligned = content.position == Position::ItemAligned;
        let geometry = if aligned {
            self.place(window, cx)
        } else {
            None
        };
        let hidden = aligned && geometry.is_none();
        if hidden {
            window.request_animation_frame();
        }
        let view = surface::View {
            rows,
            value: self.selected(cx),
            start,
            selected,
            geometry,
            popper: !aligned,
        };
        let surface = theme.scoped(cx, |cx| surface::build(self, &view, &focus, cx));
        let ds = Ds::get(cx);
        let animated = if hidden {
            Some(div().opacity(0.).child(surface).into_any_element())
        } else {
            motion::animate(
                &format!("{}-select", self.id),
                phase,
                Side::Bottom,
                // DS: Select.module.css:109 `--radix-select-content-transform-origin, center top`.
                (0.5, 0.),
                Motion::MENU,
                surface,
                ds,
            )
        };
        let Some(animated) = animated else {
            return div().into_any_element();
        };
        let handle = handle.clone();
        let select = self.clone();
        let layer = Dismissable::new(handle, animated, move |reason, window, cx| {
            // Radix Select prevents the focus-outside dismissal: the list holds focus.
            if reason != Reason::FocusOutside {
                select.set_open(false, window, cx);
            }
        })
        .focus(&focus);
        match geometry {
            Some(at) => {
                Layer::new(Z::Popover, point(px(at.left), px(at.top)), layer).into_any_element()
            }
            None if aligned => {
                Layer::new(Z::Popover, point(px(0.), px(0.)), layer).into_any_element()
            }
            None => self.popper(content, theme, layer, cx),
        }
    }

    /// Popper position: below the trigger, as wide as it at least, flipping on collision.
    fn popper(
        &self,
        content: &SelectContent,
        theme: Theme,
        layer: Dismissable,
        cx: &App,
    ) -> AnyElement {
        let options = Options {
            side: Side::Bottom,
            align: content.align,
            side_offset: 0.,
            padding: crate::ui::overlay::place::Padding::content(f32::from(
                Ds::get(cx).len(crate::tokens::Length::TitlebarSafeAreaTop),
            )),
            avoid_collisions: true,
        };
        Popper::new(
            Z::Popover,
            &self.parts.trigger,
            options,
            &self.parts.output,
            theme,
            layer,
        )
        .into_any_element()
    }
}
