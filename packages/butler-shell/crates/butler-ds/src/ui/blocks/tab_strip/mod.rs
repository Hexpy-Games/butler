//! DS TabStrip (TabStrip.tsx / TabStrip.module.css): the browser tab strip. Closable pill tabs
//! shrink to fit and scroll sideways with edge fades when they no longer fit, grouped as "my
//! tabs" plus one muted, foldable outline pill per conversation. A pure presenter: the app owns
//! the groups and the active tab, and the strip reports intents.
//!
//! Not reproduced: pointer drag-reorder and dropping a tab on a group title (the keyboard
//! reorder, Cmd/Ctrl+Shift+arrows, works), the fold's width slide, the tab enter animation and
//! the smooth scroll that reveals the active tab (it jumps).
mod fit;
mod group;
mod keys;
mod labels;
mod model;
mod parts;
mod tab;
mod util;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, Entity, FocusHandle, InteractiveElement as _, IntoElement,
    ParentElement, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _, Window,
    div, px,
};

pub use labels::TabStripLabels;
pub use model::{Favicon, Group, GroupKind, GroupState, Move, Tab, TabState, apply_move};

use crate::tokens::Length;
use crate::ui::Icon;
use crate::ui::blocks::measure;
use crate::ui::context::Ds;
use crate::ui::icon::IconSize;
use crate::ui::scroll::{self, Axis};
use model::{Stop, shows_chip, stops, tab_key};
use parts::{Ghost, ghost};
use util::{child_id, hover_listener, resting};

/// `--tab-strip-gap`: the gap between tabs, and a pill's padding.
const GAP: f32 = 2.; // DS: TabStrip.module.css:3

type Pick = Rc<dyn Fn(&str, &mut Window, &mut App)>;
type Toggle = Rc<dyn Fn(&str, bool, &mut Window, &mut App)>;
type Plain = Rc<dyn Fn(&mut Window, &mut App)>;
type MoveHandler = Rc<dyn Fn(&Move, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct TabStrip {
    id: ElementId,
    groups: Vec<Group>,
    active: Option<SharedString>,
    labels: TabStripLabels,
    hide_chip: bool,
    on_activate: Option<Pick>,
    on_close: Option<Pick>,
    on_move: Option<MoveHandler>,
    on_toggle_group: Option<Toggle>,
    on_new_tab: Option<Plain>,
    on_new_tab_in_group: Option<Pick>,
    trailing: Vec<AnyElement>,
}

impl TabStrip {
    /// `groups`: "my tabs" plus one group per conversation, in strip order.
    pub fn new(id: impl Into<ElementId>, groups: Vec<Group>) -> Self {
        Self {
            id: id.into(),
            groups,
            active: None,
            labels: TabStripLabels::default(),
            hide_chip: false,
            on_activate: None,
            on_close: None,
            on_move: None,
            on_toggle_group: None,
            on_new_tab: None,
            on_new_tab_in_group: None,
            trailing: Vec::new(),
        }
    }

    pub fn active(mut self, tab_id: Option<SharedString>) -> Self {
        self.active = tab_id;
        self
    }

    /// Localized copy; English by default.
    pub fn labels(mut self, labels: TabStripLabels) -> Self {
        self.labels = labels;
        self
    }

    /// Drops the title when the strip shows a single group of any kind (a conversation pane
    /// names it in its title bar).
    pub fn hide_chip(mut self) -> Self {
        self.hide_chip = true;
        self
    }

    /// Click, Enter or Space on a tab.
    pub fn on_activate(mut self, handler: impl Fn(&str, &mut Window, &mut App) + 'static) -> Self {
        self.on_activate = Some(Rc::new(handler));
        self
    }

    /// Close button, middle-click, or Delete/Backspace on the focused tab.
    pub fn on_close(mut self, handler: impl Fn(&str, &mut Window, &mut App) + 'static) -> Self {
        self.on_close = Some(Rc::new(handler));
        self
    }

    /// Cmd/Ctrl+Shift+arrow reorder, within and between groups. Omit to lock the order.
    pub fn on_move(mut self, handler: impl Fn(&Move, &mut Window, &mut App) + 'static) -> Self {
        self.on_move = Some(Rc::new(handler));
        self
    }

    /// A click on a group's title folds or unfolds it (`collapsed` is the new state). Omit to
    /// keep groups as they are (the titles are disabled).
    pub fn on_toggle_group(
        mut self,
        handler: impl Fn(&str, bool, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_toggle_group = Some(Rc::new(handler));
        self
    }

    /// Shows the trailing new-tab button (unless group pills carry their own).
    pub fn on_new_tab(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_new_tab = Some(Rc::new(handler));
        self
    }

    /// Ends every group pill in its own new-tab button; while pills show, the trailing one goes
    /// away.
    pub fn on_new_tab_in_group(
        mut self,
        handler: impl Fn(&str, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_new_tab_in_group = Some(Rc::new(handler));
        self
    }
}

/// Controls after the new-tab button at the row end (bring in a tab).
impl ParentElement for TabStrip {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.trailing.extend(elements);
    }
}

/// What every group, title and tab of one strip shares for one frame.
struct Scope {
    id: ElementId,
    labels: TabStripLabels,
    active: Option<SharedString>,
    active_key: Option<SharedString>,
    handles: HashMap<SharedString, FocusHandle>,
    /// The one tab stop of the strip.
    roving: Option<SharedString>,
    hovered: Option<SharedString>,
    hover: Entity<Option<SharedString>>,
    /// Stops whose keyboard focus ring shows.
    focus_lit: HashSet<SharedString>,
    fit: Option<f32>,
    group_new: bool,
    /// Widths measured on the last frame, and the recorders that measure the next.
    widths: HashMap<SharedString, f32>,
    recorders: RefCell<HashMap<SharedString, AnyElement>>,
    reveal: tab::Reveal,
    on_activate: Option<Pick>,
    on_close: Option<Pick>,
    on_toggle: Option<Toggle>,
    on_new_in: Option<Pick>,
}

impl Scope {
    fn control_id(&self, key: &str) -> ElementId {
        child_id(&self.id, key)
    }

    /// A filled neighbour: selected, hovered or keyboard-focused (its divider steps aside).
    fn lit(&self, key: &SharedString) -> bool {
        self.active_key.as_ref() == Some(key)
            || self.hovered.as_ref() == Some(key)
            || self.focus_lit.contains(key)
    }

    /// The close button shows on hover or keyboard focus only, the selected tab included
    /// (`.slot:hover .close`, `.slot > .tab:focus-visible .close`; TabStrip.module.css:217-236).
    fn reveals_close(&self, key: &SharedString) -> bool {
        self.hovered.as_ref() == Some(key) || self.focus_lit.contains(key)
    }

    fn width(&self, key: &SharedString) -> f32 {
        self.widths.get(key).copied().unwrap_or(0.)
    }

    fn recorder(&self, key: &SharedString) -> Option<AnyElement> {
        self.recorders.borrow_mut().remove(key)
    }
}

/// The keys the strip measures: the row, its other children, every pill and every open tab.
fn measured(strip: &TabStrip, pills: &[&Group], others: (bool, bool)) -> Vec<SharedString> {
    let mut keys = vec![SharedString::from("root")];
    if others.0 {
        keys.push("new".into());
    }
    if others.1 {
        keys.push("trailing".into());
    }
    keys.extend(
        pills
            .iter()
            .map(|group| SharedString::from(format!("pill:{}", group.id))),
    );
    for group in strip.groups.iter().filter(|group| !group.collapsed) {
        keys.extend(group.tabs.iter().map(|tab| tab_key(&tab.id)));
    }
    keys
}

/// What the strip is made of, before anything is measured.
struct Layout {
    /// Every group is a pill and ends in its own new-tab button.
    group_new: bool,
    stops: Vec<Stop>,
    /// Whether the row has a new-tab button and a trailing slot beside the scroller.
    others: (bool, bool),
}

impl TabStrip {
    fn pills(&self) -> Vec<&Group> {
        let shown = |group: &&Group| shows_chip(group, &self.groups, self.hide_chip);
        self.groups.iter().filter(shown).collect()
    }

    fn layout(&self) -> Layout {
        let group_new = !self.pills().is_empty() && self.on_new_tab_in_group.is_some();
        let mut list = stops(&self.groups, self.hide_chip, group_new);
        if self.on_toggle_group.is_none() {
            // A disabled title takes no focus.
            list.retain(|stop| !matches!(stop, Stop::Chip { .. }));
        }
        Layout {
            group_new,
            stops: list,
            others: (
                self.on_new_tab.is_some() && !group_new,
                !self.trailing.is_empty(),
            ),
        }
    }

    /// Everything that needs the window: focus handles, hover, measured sizes.
    fn scope(
        &self,
        layout: &Layout,
        reveal: tab::Reveal,
        window: &mut Window,
        cx: &mut App,
    ) -> Scope {
        let keyboard = Ds::get(cx).modality().focus_visible();
        let mut handles = HashMap::new();
        let mut focus_lit = HashSet::new();
        for stop in &layout.stops {
            let key = stop.key();
            let handle = window
                .use_keyed_state((child_id(&self.id, &key), "focus"), cx, |_, cx| {
                    cx.focus_handle()
                })
                .read(cx)
                .clone();
            if keyboard && handle.is_focused(window) {
                focus_lit.insert(key.clone());
            }
            handles.insert(key, handle);
        }
        let focused = layout
            .stops
            .iter()
            .find(|stop| handles[&stop.key()].is_focused(window))
            .map(Stop::key);
        let roving = focused.or_else(|| resting(&self.groups, &layout.stops, self.active.as_ref()));
        let hover =
            window.use_keyed_state((self.id.clone(), "hover"), cx, |_, _| None::<SharedString>);
        let mut widths = HashMap::new();
        let mut recorders = HashMap::new();
        for key in measured(self, &self.pills(), layout.others) {
            let id = child_id(&self.id, &format!("m-{key}"));
            let (size, recorder) = measure::track(id, window, cx);
            widths.insert(key.clone(), f32::from(size.width));
            recorders.insert(key, recorder);
        }
        Scope {
            id: self.id.clone(),
            labels: self.labels.clone(),
            active: self.active.clone(),
            active_key: self.active.as_deref().map(tab_key),
            handles,
            roving,
            hovered: hover.read(cx).clone(),
            hover,
            focus_lit,
            fit: None,
            group_new: layout.group_new,
            widths,
            recorders: RefCell::new(recorders),
            reveal,
            on_activate: self.on_activate.clone(),
            on_close: self.on_close.clone(),
            on_toggle: self.on_toggle_group.clone(),
            on_new_in: self.on_new_tab_in_group.clone(),
        }
    }

    /// The shared tab width inside pills (none while a strip without pills shrinks in layout).
    fn fit(&self, scope: &Scope, others: (bool, bool), ds: &Ds) -> Option<f32> {
        let pills = self.pills();
        if pills.is_empty() {
            return None;
        }
        let xs = f32::from(ds.len(Length::SpaceXs));
        let new = scope.width(&"new".into()).max(parts::ghost_side(ds));
        let trailing = scope.width(&"trailing".into());
        let others = f32::from(others.0) * (new + xs) + f32::from(others.1) * (trailing + xs);
        fit::fit_width(
            &fit::Row {
                widths: &scope.widths,
                pills: &pills,
                others,
                active: scope.active.as_ref(),
            },
            ds,
        )
    }

    /// The groups in the horizontal scroller with its edge fades.
    fn scroller(&self, scope: &Scope, mut fade: scroll::Fade, ds: &Ds) -> AnyElement {
        let lone = self.hide_chip && self.groups.len() == 1;
        let items: Vec<AnyElement> = self
            .groups
            .iter()
            .flat_map(|group| {
                let titled = shows_chip(group, &self.groups, self.hide_chip);
                group::view(group, scope, titled, lone, ds)
            })
            .collect();
        // Group pills sit a step apart.
        let gap = if self.pills().is_empty() {
            px(GAP)
        } else {
            ds.len(Length::SpaceXs)
        };
        let row = div()
            .flex()
            .flex_row()
            .items_center()
            .min_w_0()
            .p(ds.len(Length::FocusRingWidth))
            .gap(gap)
            .children(items)
            .id((child_id(&self.id, "scroller"), "scroll"))
            .track_scroll(&fade.handle)
            .track_focus(&fade.focus)
            .overflow_x_scroll()
            .children(fade.watch());
        fade.mask(row.into_any_element())
    }

    /// The row's own new-tab button (group pills carry their own instead).
    fn new_tab(&self, scope: &Scope, ds: &Ds) -> Option<AnyElement> {
        let new = self.on_new_tab.clone()?;
        let button = ghost(
            Ghost {
                id: scope.control_id("new-tab"),
                label: self.labels.new_tab.clone(),
                glyph: Icon::Plus,
                size: IconSize::Md,
                handle: None,
                tab_stop: true,
                on_click: Some(new),
            },
            ds,
        );
        Some(
            div()
                .relative()
                .flex()
                .flex_none()
                .child(button)
                .children(scope.recorder(&"new".into()))
                .into_any_element(),
        )
    }

    /// Row-end controls (bring in a tab): pinned to the end, never scrolled away.
    fn trailing(&mut self, scope: &Scope, ds: &Ds) -> AnyElement {
        div()
            .relative()
            .flex()
            .flex_none()
            .items_center()
            .gap(ds.len(Length::SpaceXs))
            .ml_auto()
            .children(std::mem::take(&mut self.trailing))
            .children(scope.recorder(&"trailing".into()))
            .into_any_element()
    }

    fn key_handler(&self, layout: &Layout, scope: &Scope) -> keys::Keys {
        let stops = layout
            .stops
            .iter()
            .filter_map(|stop| Some((stop.clone(), scope.handles.get(&stop.key())?.clone())))
            .collect();
        keys::Keys {
            stops,
            groups: self.groups.clone(),
            on_close: self.on_close.clone(),
            on_move: self.on_move.clone(),
        }
    }
}

impl RenderOnce for TabStrip {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let layout = self.layout();
        let fade_size = Ds::get(cx).len(Length::ScrollFadeSize);
        let fade = scroll::fade(
            &scroll::Config {
                id: child_id(&self.id, "scroller"),
                axis: Axis::X,
                size: fade_size,
                guard: px(0.),
            },
            None,
            false,
            window,
            cx,
        );
        let done =
            window.use_keyed_state(
                (self.id.clone(), "revealed"),
                cx,
                |_, _| None::<SharedString>,
            );
        let reveal = tab::Reveal {
            handle: fade.handle.clone(),
            done,
            fade: fade_size,
        };
        let mut scope = self.scope(&layout, reveal, window, cx);
        let ds = Ds::get(cx);
        scope.fit = self.fit(&scope, layout.others, ds);
        let scroller = self.scroller(&scope, fade, ds);
        let new_tab = if layout.others.0 {
            self.new_tab(&scope, ds)
        } else {
            None
        };
        let trailing = layout.others.1.then(|| self.trailing(&scope, ds));
        let keys = keys::handler(self.key_handler(&layout, &scope));
        div()
            .id((self.id.clone(), "root"))
            .relative()
            .flex()
            .w_full()
            .min_w_0()
            .items_center()
            .gap(ds.len(Length::SpaceXs))
            .on_key_down(keys)
            .child(scroller)
            .children(new_tab)
            .children(trailing)
            .children(scope.recorder(&"root".into()))
    }
}
