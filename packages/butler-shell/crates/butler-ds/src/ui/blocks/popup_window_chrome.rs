//! DS PopupWindowChrome (PopupWindowChrome.tsx / PopupWindowChrome.module.css): the whole
//! document of a Butler-owned pop-up window (sign-in, payment). A compact 40px title bar with the
//! lock, the host and the window controls, over the page area (a child, normally a `PageCard`),
//! inset like a card. Solid, like Butler's other windows.
//!
//! On macOS the bar reserves the native traffic lights at the start (a pop-up's lights sit at x
//! 12, so 64px) and starts the lock where TitlebarShell's first leading glyph starts. Elsewhere
//! nothing is reserved and the caller's `window_controls` sit at the end. The platform and the
//! window's fullscreen state come in as inputs; the caller passes the control element.
//!
//! Not reproduced: the lock's `role="img"` name (`security_label`; the shell has no
//! accessibility tree yet). In fullscreen the OS hides the lights, so nothing is reserved at the
//! start (React has no fullscreen input: pop-ups there are never fullscreen).
use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement, RenderOnce,
    SharedString, Styled as _, Window, WindowControlArea, div, px,
};

use super::adaptive_shell::ShellPlatform;
use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::context::Ds;
use crate::ui::icon::{IconSize, icon};
use crate::ui::strut;
use crate::ui::typo::{Role, Typo, Weight};

/// `--popup-lights-reserve`: the native lights of a pop-up sit at x 12.
const LIGHTS_RESERVE: f32 = 64.; // DS: PopupWindowChrome.module.css:9

#[derive(IntoElement)]
pub struct PopupWindowChrome {
    id: ElementId,
    host: SharedString,
    security_label: SharedString,
    secure: bool,
    platform: ShellPlatform,
    fullscreen: bool,
    window_controls: Option<AnyElement>,
    children: Vec<AnyElement>,
}

impl PopupWindowChrome {
    /// `host` is the pop-up's origin; it titles the window. `security_label` names the lock
    /// ("Secure connection" / "Not secure").
    pub fn new(
        id: impl Into<ElementId>,
        host: impl Into<SharedString>,
        security_label: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            host: host.into(),
            security_label: security_label.into(),
            secure: true,
            platform: ShellPlatform::Darwin,
            fullscreen: false,
            window_controls: None,
            children: Vec::new(),
        }
    }

    /// False draws the warning glyph in the warning colour instead of the lock.
    pub fn secure(mut self, secure: bool) -> Self {
        self.secure = secure;
        self
    }

    /// Darwin reserves the native traffic lights at the start; other platforms put
    /// `window_controls` at the end. Default Darwin.
    pub fn platform(mut self, platform: ShellPlatform) -> Self {
        self.platform = platform;
        self
    }

    /// A fullscreen window has no lights to reserve room for.
    pub fn fullscreen(mut self, fullscreen: bool) -> Self {
        self.fullscreen = fullscreen;
        self
    }

    /// The window controls the app draws (ignored on Darwin, where the OS draws them).
    pub fn window_controls(mut self, controls: impl IntoElement) -> Self {
        self.window_controls = Some(controls.into_any_element());
        self
    }

    /// The accessible name of the lock glyph (gpui draws none of it).
    pub fn aria_label(&self) -> &SharedString {
        &self.security_label
    }
}

impl ParentElement for PopupWindowChrome {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// `--popup-leading-start`: after the lights' reserve comes the toggle inset, and the lock sits
/// where the floating toggle's glyph sits.
fn leading_start(ds: &Ds) -> gpui::Pixels {
    px(LIGHTS_RESERVE)
        + ds.len(Length::ChromeToggleInset)
        + (ds.len(Length::ChromeFloatingToggleSize) - ds.len(Length::ChromeFloatingToggleIconSize))
            / 2.
}

impl PopupWindowChrome {
    fn bar(&mut self, ds: &Ds) -> impl IntoElement + use<> {
        let darwin = self.platform == ShellPlatform::Darwin;
        let start = if darwin && !self.fullscreen {
            leading_start(ds)
        } else {
            ds.len(Length::SpaceMd)
        };
        let lock_color = if self.secure {
            Color::TextTertiary
        } else {
            Color::ColorWarningText
        };
        let glyph = if self.secure {
            Icon::Lock
        } else {
            Icon::Warning
        };
        let lock = div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .text_color(ds.color(lock_color))
            .child(icon(glyph, IconSize::Sm, ds));
        let host = div().min_w_0().overflow_hidden().child(
            Typo::new(Role::Text, self.host.clone())
                .weight(Weight::Medium)
                .truncate(),
        );
        let controls = self
            .window_controls
            .take()
            .filter(|_| !darwin)
            .map(|controls| div().flex().ml_auto().child(controls));
        strut::scope(
            false,
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(ds.len(Length::SpaceSm))
                .h(ds.len(Length::BrowserBandHeight))
                .pl(start)
                .pr(ds.len(Length::SpaceSm))
                .text_size(ds.len(Length::FontSize2))
                .line_height(ds.len(Length::TypoLabelLineHeight))
                .window_control_area(WindowControlArea::Drag)
                .child(lock)
                .child(host)
                .children(controls),
        )
    }
}

impl RenderOnce for PopupWindowChrome {
    fn render(mut self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let bar = self.bar(ds);
        // The page sits in the window like a card, inset from its edges.
        let page = div()
            .flex()
            .flex_col()
            .flex_auto()
            .min_h_0()
            .mx(ds.len(Length::SpaceXs))
            .mb(ds.len(Length::SpaceXs))
            .overflow_hidden()
            .rounded(ds.len(Length::RadiusPanel))
            .bg(ds.color(Color::SurfaceRaised))
            .children(self.children);
        strut::scope(
            false,
            div()
                .id(self.id)
                .flex()
                .flex_col()
                .size_full()
                .min_h_0()
                .bg(ds.color(Color::Popover))
                .text_color(ds.color(Color::TextPrimary))
                .child(bar)
                .child(page),
        )
    }
}
