//! DS NativeSelect (shadcn/ui/native-select.tsx, NativeSelect.module.css): the Input's box
//! showing the chosen option's label, a chevron, and the operating system's popup menu for the
//! choice. The trigger takes keyboard focus (the ring shows for keys only; the border takes the
//! accent on any focus). Opening asks the window for the OS popup menu (`Window::popup_menu`);
//! where the platform has none (Linux, where Chromium draws its own `<select>` popup too) the
//! DS Select's list opens over the trigger instead.
use std::rc::Rc;

use gpui::{
    App, Bounds, ElementId, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    Pixels, PopupMenuItem, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _,
    Window, canvas, div, px,
};

use super::Icon;
use super::context::Ds;
use super::control::next_anchor;
use super::convert;
use super::focus;
use super::icon::{IconSize, icon};
use super::select::{Select, SelectContent, SelectItem};
use super::strut;
use crate::tokens::{Color, Length};

type Handler = Rc<dyn Fn(&str, &mut Window, &mut App)>;

/// `size`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Size {
    #[default]
    Default,
    Sm,
}

#[derive(Clone)]
struct Choice {
    value: SharedString,
    label: SharedString,
}

/// A row of the menu: a choice or a group heading.
#[derive(Clone)]
enum Entry {
    Option(Choice),
    Group(SharedString),
}

/// `min-width: min(160px, 100%)` (DS: NativeSelect.module.css:8).
const MIN_WIDTH: f32 = 160.;
/// `min-height: 34px` (sm 30px) (DS: NativeSelect.module.css:19, :37).
const HEIGHT: f32 = 34.;
const HEIGHT_SM: f32 = 30.;
/// Padding `0 34px 0 10px` (DS: NativeSelect.module.css:25).
const PAD_START: f32 = 10.;
const PAD_END: f32 = 34.;
/// The chevron sits 10px from the end (DS: NativeSelect.module.css:56).
const CHEVRON_END: f32 = 10.;

#[derive(IntoElement)]
pub struct NativeSelect {
    id: ElementId,
    size: Size,
    stretch: bool,
    default_value: Option<SharedString>,
    value: Option<SharedString>,
    disabled: bool,
    entries: Vec<Entry>,
    on_change: Option<Handler>,
    probe: Option<SharedString>,
}

impl NativeSelect {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            size: Size::Default,
            stretch: false,
            default_value: None,
            value: None,
            disabled: false,
            entries: Vec::new(),
            on_change: None,
            probe: None,
        }
    }

    pub fn size(mut self, size: Size) -> Self {
        self.size = size;
        self
    }

    /// Fill the container's width.
    pub fn stretch(mut self) -> Self {
        self.stretch = true;
        self
    }

    /// The choice the select starts on (`defaultValue`).
    pub fn default_value(mut self, value: impl Into<SharedString>) -> Self {
        self.default_value = Some(value.into());
        self
    }

    /// The choice the owner holds (`value`).
    pub fn value(mut self, value: impl Into<SharedString>) -> Self {
        self.value = Some(value.into());
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    /// `<option value>label</option>`.
    pub fn option(
        mut self,
        value: impl Into<SharedString>,
        label: impl Into<SharedString>,
    ) -> Self {
        self.entries.push(Entry::Option(Choice {
            value: value.into(),
            label: label.into(),
        }));
        self
    }

    /// `<optgroup label>` with its options.
    pub fn group<V, L>(
        mut self,
        label: impl Into<SharedString>,
        options: impl IntoIterator<Item = (V, L)>,
    ) -> Self
    where
        V: Into<SharedString>,
        L: Into<SharedString>,
    {
        self.entries.push(Entry::Group(label.into()));
        for (value, label) in options {
            self = self.option(value, label);
        }
        self
    }

    pub fn on_change(mut self, handler: impl Fn(&str, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }

    /// Names a zero-size marker, `<name>:popup:os` or `<name>:popup:list`, for the menu the last
    /// open used (the OS popup, or the DS list where the platform has none), for a harness
    /// expectation. Only the test build draws it.
    pub fn probe(mut self, name: impl Into<SharedString>) -> Self {
        self.probe = Some(name.into());
        self
    }

    /// The DS list the fallback opens: the options, with a group's heading as a label.
    fn list(&self) -> SelectContent {
        self.entries
            .iter()
            .fold(SelectContent::new(), |list, entry| match entry {
                Entry::Option(choice) => {
                    list.child(SelectItem::new(choice.value.clone(), choice.label.clone()))
                }
                Entry::Group(label) => list.child(super::select::Entry::label(label.clone())),
            })
    }

    fn choices(&self) -> impl Iterator<Item = &Choice> {
        self.entries.iter().filter_map(|entry| match entry {
            Entry::Option(choice) => Some(choice),
            Entry::Group(_) => None,
        })
    }
}

/// Which menu the last open used.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Popup {
    /// The OS popup menu.
    Os,
    /// The DS Select's list, on a platform without one.
    List,
}

/// What opening the menu needs: where the trigger is, what it lists and what is chosen.
struct Menu {
    trigger: Entity<Bounds<Pixels>>,
    entries: Vec<Entry>,
    selected: Option<SharedString>,
    chosen: Entity<Option<SharedString>>,
    popup: Entity<Option<Popup>>,
    list: Select,
    on_change: Option<Handler>,
    anchor: SharedString,
}

impl Menu {
    /// The menu's rows as the OS lists them.
    fn items(&self) -> Vec<PopupMenuItem> {
        self.entries
            .iter()
            .map(|entry| match entry {
                Entry::Option(choice) => PopupMenuItem::Option {
                    label: choice.label.clone(),
                    enabled: true,
                },
                Entry::Group(label) => PopupMenuItem::Group {
                    label: label.clone(),
                },
            })
            .collect()
    }

    /// Opens the OS popup menu over the trigger and applies the pick; without one, the list.
    fn open(self: &Rc<Self>, window: &mut Window, cx: &mut App) {
        let anchor = *self.trigger.read(cx);
        let selected = self.entries.iter().position(|entry| {
            matches!(entry, Entry::Option(choice) if Some(&choice.value) == self.selected.as_ref())
        });
        let Some(picked) = window.popup_menu(&self.items(), selected, anchor) else {
            self.popup.update(cx, |popup, _| *popup = Some(Popup::List));
            self.list.open(window, cx);
            return;
        };
        self.popup.update(cx, |popup, _| *popup = Some(Popup::Os));
        let menu = self.clone();
        window
            .spawn(cx, async move |cx| {
                let Ok(Some(index)) = picked.await else {
                    return;
                };
                cx.update(|window, cx| menu.pick(index, window, cx)).ok();
            })
            .detach();
    }

    /// Chooses the option at `index` of the entries.
    fn pick(&self, index: usize, window: &mut Window, cx: &mut App) {
        if let Some(Entry::Option(choice)) = self.entries.get(index) {
            self.choose(&choice.value, window, cx);
        }
    }

    fn choose(&self, value: &SharedString, window: &mut Window, cx: &mut App) {
        choose(&self.chosen, self.on_change.as_ref(), value, window, cx);
    }
}

/// Records the choice and tells the owner.
fn choose(
    chosen: &Entity<Option<SharedString>>,
    on_change: Option<&Handler>,
    value: &SharedString,
    window: &mut Window,
    cx: &mut App,
) {
    chosen.update(cx, |chosen, cx| {
        *chosen = Some(value.clone());
        cx.notify();
    });
    if let Some(on_change) = on_change {
        on_change(value, window, cx);
    }
}

impl RenderOnce for NativeSelect {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let live = !self.disabled;
        let handle = live.then(|| {
            window
                .use_keyed_state((self.id.clone(), "focus"), cx, |_, cx| cx.focus_handle())
                .read(cx)
                .clone()
        });
        let anchor = next_anchor(cx, handle.as_ref());
        let chosen =
            window.use_keyed_state((self.id.clone(), "chosen"), cx, |_, _| None::<SharedString>);
        let trigger = window.use_keyed_state((self.id.clone(), "box"), cx, |_, _| {
            Bounds::<Pixels>::default()
        });
        let current = self
            .value
            .clone()
            .or_else(|| chosen.read(cx).clone())
            .or_else(|| self.default_value.clone());
        // The chosen option's label, or the first option's when none matches.
        let label = self
            .choices()
            .find(|choice| Some(&choice.value) == current.as_ref())
            .or_else(|| self.choices().next())
            .map(|choice| choice.label.clone())
            .unwrap_or_default();
        let shrink = strut::shrink_wrap(cx);
        let focused = handle.as_ref().is_some_and(|h| h.is_focused(window));
        let ring =
            focused && focus::visible(Ds::get(cx), true, false) && !focus::ring_handed_off(cx);
        let popup = window.use_keyed_state((self.id.clone(), "popup"), cx, |_, _| None::<Popup>);
        let (picked, on_change) = (chosen.clone(), self.on_change.clone());
        let list = Select::new(format!("{}-list", self.id), window, cx)
            .value(current.clone())
            .on_value_change(move |value, window, cx| {
                choose(&picked, on_change.as_ref(), &value, window, cx);
            });
        let layer = list.content(&self.list(), window, cx);
        let menu = Rc::new(Menu {
            trigger: trigger.clone(),
            entries: self.entries.clone(),
            selected: current,
            chosen,
            popup,
            list,
            on_change: self.on_change.clone(),
            anchor,
        });
        assemble(
            &self,
            label,
            menu,
            handle,
            (focused, ring, shrink),
            (layer, cx),
        )
    }
}

/// The root: size rules, the trigger, the box measure, and focus, click and key handling.
fn assemble(
    select: &NativeSelect,
    label: SharedString,
    menu: Rc<Menu>,
    handle: Option<gpui::FocusHandle>,
    (focused, ring, shrink): (bool, bool, bool),
    (layer, cx): (gpui::AnyElement, &App),
) -> gpui::AnyElement {
    let ds = Ds::get(cx);
    let anchor = menu.anchor.clone();
    let mut root = div()
        .id(select.id.clone())
        .relative()
        .debug_selector(move || anchor.to_string());
    if select.stretch {
        root = root.w_full();
    }
    // `min-width: min(160px, 100%)`: in a track the item sizes, 100% is the item's own width.
    if !strut::auto_track(cx) {
        root = root.min_w(px(MIN_WIDTH));
    }
    root = root.max_w_full().flex().flex_none();
    let height = match select.size {
        Size::Default => HEIGHT,
        Size::Sm => HEIGHT_SM,
    };
    let height = if ds.compact() {
        px(height).max(ds.len(Length::ControlHitTarget))
    } else {
        px(height)
    };
    let content = field(select, ds, label, height, focused, ring);
    let trigger = menu.trigger.clone();
    let measure = canvas(
        |_, _, _| (),
        move |bounds, (), _, cx| {
            trigger.update(cx, |box_, _| *box_ = bounds);
        },
    )
    .absolute()
    .size_full()
    .top_0()
    .left_0();
    let marker = popup_marker(select, &menu, cx);
    let root = root
        .child(content)
        .child(measure)
        .child(menu.list.trigger_probe())
        .child(layer)
        .children(marker);
    let root = match handle {
        Some(handle) => {
            let keys = menu.clone();
            let room = focus::room(ds);
            root.track_focus(&focus::tab_stop(&handle, true))
                .cursor_pointer()
                .on_click(move |_, window, cx| menu.open(window, cx))
                .on_key_down(move |event, window, cx| {
                    if matches!(event.keystroke.key.as_str(), "up" | "down") {
                        cx.stop_propagation();
                        keys.open(window, cx);
                    }
                })
                .children(focused.then(|| focus::publish(handle, room)))
                .into_any_element()
        }
        None => root.cursor_default().into_any_element(),
    };
    // `width: max-content` (the default): the content's width, whatever the container does.
    if select.stretch || !shrink {
        root
    } else {
        strut::max_content(root)
    }
}

/// The `probe` marker naming the menu the last open used.
fn popup_marker(select: &NativeSelect, menu: &Menu, cx: &App) -> Option<gpui::Div> {
    let name = select.probe.as_ref()?;
    let label = match (*menu.popup.read(cx))? {
        Popup::Os => format!("{name}:popup:os"),
        Popup::List => format!("{name}:popup:list"),
    };
    Some(div().absolute().size_0().debug_selector(move || label))
}

/// The trigger: the Input's box with the label, the chevron over its end padding.
fn field(
    select: &NativeSelect,
    ds: &Ds,
    label: SharedString,
    height: Pixels,
    focused: bool,
    ring: bool,
) -> gpui::Div {
    let line = ds.color(Color::Line);
    let radius = match select.size {
        Size::Default => ds.len(Length::RadiusControl),
        Size::Sm => ds
            .len(Length::RadiusControl)
            .min(ds.len(Length::RadiusPanel)),
    };
    let border = if focused {
        convert::mix(ds.color(Color::Accent), line, 0.52)
    } else {
        line
    };
    let size = ds.len(Length::FontSize3);
    let surface = div()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .rounded(radius)
        .bg(convert::with_alpha(ds.color(Color::SurfaceRaised), 0.92))
        .border(ds.len(Length::BorderHairline))
        .border_color(border);
    let ring = ring.then(|| super::control::ring_layer(focus::shadows(ds), radius));
    let chevron = div()
        .absolute()
        .top_0()
        .bottom_0()
        .right(px(CHEVRON_END))
        .flex()
        .items_center()
        .text_color(ds.color(Color::TextTertiary))
        .child(icon(Icon::ChevronDown, IconSize::Md, ds));
    div()
        .relative()
        .flex()
        .items_center()
        .w_full()
        .min_h(height)
        .pl(px(PAD_START) + ds.len(Length::BorderHairline))
        .pr(px(PAD_END) + ds.len(Length::BorderHairline))
        .gap(ds.len(Length::Space2))
        .text_color(ds.color(Color::TextPrimary))
        .text_size(size)
        .line_height(size)
        .child(surface)
        .children(ring)
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(label),
        )
        .child(chevron)
}
