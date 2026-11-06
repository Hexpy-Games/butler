//! The slots of an AdaptiveShell that are elements in their own right (AdaptiveShellParts.tsx):
//! the content card, the chrome layer with its floating toggle, the scrim, the peek edge and the
//! drawer's panel titlebar.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement as _,
    RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _, Window, div, px,
};

use crate::tokens::{Color, Length};
use crate::ui::blocks::scope::{self, ActionScale, Spec};
use crate::ui::context::Ds;
use crate::ui::{convert, strut};

pub type Callback = Rc<dyn Fn(&mut Window, &mut App)>;

/// `AdaptiveShellCard`: the content under the title row. Flat: layout only. Cards: a rounded
/// card inset from the window, the box a wallpaper resolves against.
#[derive(IntoElement)]
pub struct ShellCard {
    children: Vec<AnyElement>,
}

impl ShellCard {
    pub fn new() -> Self {
        Self {
            children: Vec::new(),
        }
    }
}

impl Default for ShellCard {
    fn default() -> Self {
        Self::new()
    }
}

impl gpui::ParentElement for ShellCard {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// The box of a content card in the cards frame: its own quiet edge, radius and surface.
pub fn card_surface(el: gpui::Div, ds: &Ds, transparent: bool) -> gpui::Div {
    let bg = if transparent {
        gpui::transparent_black()
    } else {
        ds.color(Color::ShellCardBg)
    };
    el.relative()
        .overflow_hidden()
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::ShellCardEdge))
        .rounded(ds.len(Length::ShellCardRadius))
        .bg(bg)
}

impl RenderOnce for ShellCard {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let vars = scope::vars(cx);
        let el = div().flex().flex_col().flex_auto().min_w_0().min_h_0();
        let el = match vars.filter(|v| v.cards_docked) {
            Some(vars) => card_surface(el, ds, vars.transparent_workspace),
            None => el,
        };
        strut::scope(false, el.children(self.children))
    }
}

/// `ChromeFloatingToggleLayer`: the layer over the shell that holds the floating sidebar toggle
/// at the top-left, where the title row leaves room for it. It reads the shell it is in when it
/// lays out, so the toggle follows the shell's platform.
#[derive(IntoElement)]
pub struct ChromeFloatingToggle {
    id: ElementId,
    toggle: AnyElement,
}

impl ChromeFloatingToggle {
    pub fn new(id: impl Into<ElementId>, toggle: impl IntoElement) -> Self {
        Self {
            id: id.into(),
            toggle: toggle.into_any_element(),
        }
    }
}

impl RenderOnce for ChromeFloatingToggle {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let vars = scope::vars(cx);
        let size = f32::from(ds.len(Length::ChromeFloatingToggleSize));
        let left = vars.map_or_else(
            || f32::from(ds.len(Length::ChromeFloatingToggleLeft)),
            |v| v.chrome_toggle_left,
        );
        let top = f32::from(ds.len(Length::ChromeFloatingToggleTop));
        let icon = f32::from(ds.len(Length::ChromeFloatingToggleIconSize));
        let toggle = scope::scoped(
            Spec {
                action: Some(ActionScale { side: size, icon }),
                ..Spec::default()
            },
            self.toggle,
        );
        div()
            .id(self.id)
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .child(div().absolute().top(px(top)).left(px(left)).child(toggle))
    }
}

/// The toggle's box in the shell, for the peek's hover area (`data-peek-companion`).
pub fn toggle_bounds(ds: &Ds, left: f32) -> (f32, f32, f32, f32) {
    let size = f32::from(ds.len(Length::ChromeFloatingToggleSize));
    (
        left,
        f32::from(ds.len(Length::ChromeFloatingToggleTop)),
        size,
        size,
    )
}

/// `AdaptiveShellScrim`: the drawer's dimmed backdrop; a press dismisses.
pub fn scrim(
    id: impl Into<ElementId>,
    label: SharedString,
    alpha: f32,
    on_dismiss: Option<Callback>,
    ds: &Ds,
) -> AnyElement {
    let color = convert::with_alpha(ds.color(Color::AdaptiveScrimBg), alpha);
    let el = div()
        .id(id)
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .bg(color);
    match on_dismiss {
        Some(dismiss) => el
            .debug_selector(move || format!("scrim:{label}"))
            .on_click(move |_, window, cx| dismiss(window, cx))
            .into_any_element(),
        None => el.into_any_element(),
    }
}

/// `AdaptivePanelTitlebar`: the compact inspector's title row (a close control), pinned to the
/// top right over the sheet; hidden while the inspector is closed.
pub fn panel_titlebar(content: AnyElement, width: f32, ds: &Ds, open: bool) -> AnyElement {
    let el = div()
        .absolute()
        .top_0()
        .right_0()
        .w(px(width))
        .h(ds.len(Length::TitlebarSafeAreaTop))
        .flex()
        .items_end()
        .justify_end()
        .px(ds.len(Length::SpaceLg))
        .pt(ds.len(Length::SafeAreaTop));
    if open {
        el.child(content).into_any_element()
    } else {
        el.into_any_element()
    }
}
