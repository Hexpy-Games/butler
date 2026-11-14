//! Window inputs and the sidebar preference suspended while the sidebar is a drawer.
use butler_ds::ui::blocks::adaptive_shell::frame::{
    AutoCollapse, CHAT_WIDTH_DEFAULT, MIN_PAGE_WIDTH, sidebar_auto_collapses,
};
use butler_ds::ui::blocks::adaptive_shell::grip::Drag;
use butler_ds::ui::context::{Ds, Platform};
use gpui::{Context, Window};

use super::{FocusComposer, Shell, ShellOptions};

pub(super) struct FrameState {
    /// The text scale last applied to the native window.
    pub scale: Option<f32>,
    pub width: f32,
    pub suspended: Option<bool>,
    pub resize_start: Option<f32>,
    /// `useSidebarAutoCollapse`'s state (the hysteresis input).
    pub auto_collapsed: bool,
    /// Whether the sidebar is open as of the last frame (the title row follows it).
    pub open: bool,
}

impl Default for FrameState {
    fn default() -> Self {
        Self {
            scale: None,
            width: 304.,
            suspended: None,
            resize_start: None,
            auto_collapsed: false,
            open: true,
        }
    }
}

fn ds_platform(platform: crate::ui::theme::Platform) -> Platform {
    match platform {
        crate::ui::theme::Platform::Mac => Platform::Mac,
        crate::ui::theme::Platform::Windows => Platform::Windows,
        crate::ui::theme::Platform::Linux => Platform::Linux,
    }
}

impl Shell {
    pub(super) fn install_ds(
        options: &ShellOptions,
        dark: bool,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        let tokens = butler_ds::tokens::TokenContext {
            dark,
            sidebar_solid: window.background_appearance()
                != gpui::WindowBackgroundAppearance::Acrylic,
            ..butler_ds::tokens::TokenContext::DEFAULT
        };
        let mut ds = Ds::new(tokens, ds_platform(options.platform));
        ds.detect_fonts(&cx.text_system().all_font_names());
        ds.set_lang(options.locale.ds_lang());
        if let Some(scale) = options
            .saved
            .text_size
            .as_deref()
            .and_then(super::settings_link::text_scale)
        {
            ds.set_ui_scale(scale);
        }
        ds.install(cx);
    }

    pub(super) fn frame_inputs(&mut self, window: &Window, cx: &mut Context<Self>) {
        let scale = Ds::get(cx).tokens().ui_scale;
        if self.frame.scale != Some(scale) {
            self.frame.scale = Some(scale);
            crate::lifecycle::window::apply_text_scale(window, scale, cx);
        }
        let size = window.viewport_size();
        let drawer = f32::from(size.width) <= 640.;
        if drawer && self.frame.suspended.is_none() {
            self.frame.suspended = Some(self.sidebar_open);
            self.sidebar_open = false;
        } else if !drawer && let Some(open) = self.frame.suspended.take() {
            self.sidebar_open = open;
        }
        let platform = ds_platform(self.theme.platform);
        let reduced = cx.reduce_motion();
        let display = butler_platform::display_accessibility::read();
        Ds::update(cx, |ds| {
            ds.set_viewport(size.width.into(), size.height.into());
            ds.set_platform(platform);
            ds.set_dark(self.theme.dark);
            ds.set_os_reduced_motion(reduced);
            ds.set_os_reduced_transparency(display.reduce_transparency);
            ds.set_os_increased_contrast(display.increase_contrast);
        });
    }

    /// `useSidebarAutoCollapse` (`useBrowserShell.ts`): while the right slot holds a pane, the
    /// docked sidebar steps aside when the page would be narrower than `MIN_PAGE_WIDTH`.
    pub(super) fn sidebar_auto_collapsed(&mut self, shell_width: f32, cx: &gpui::App) -> bool {
        let pane_open = self.store.selected().is_some_and(|chat| {
            let files = crate::ui::viewer::session_files(cx, chat.session.0.as_ref());
            crate::ui::viewer::right_slot_pane(None, &files).is_some()
        });
        self.frame.auto_collapsed = pane_open
            && sidebar_auto_collapses(AutoCollapse {
                shell_width,
                sidebar_width: self.frame.width,
                chat_width: self.split_chat_width().unwrap_or(CHAT_WIDTH_DEFAULT),
                collapsed: self.frame.auto_collapsed,
                min_page_width: MIN_PAGE_WIDTH,
            });
        self.frame.auto_collapsed
    }

    pub(super) fn resize_sidebar(&mut self, width: f32, cx: &mut Context<Self>) {
        if width < 248. {
            self.sidebar_open = false;
            self.frame.resize_start = None;
        } else {
            self.frame.width = width.clamp(248., 420.);
        }
        cx.notify();
    }

    pub(super) fn sidebar_width(&self, cx: &gpui::App) -> f32 {
        self.frame
            .width
            .min((Ds::get(cx).tokens().viewport.0 - 320.).max(0.))
    }

    pub(super) fn sidebar_drag(&mut self, drag: Drag, cx: &mut Context<Self>) {
        match drag {
            Drag::Begin => self.frame.resize_start = Some(self.sidebar_width(cx)),
            Drag::Move(delta) => {
                if let Some(start) = self.frame.resize_start {
                    self.resize_sidebar(start + delta, cx);
                }
            }
            Drag::End => self.frame.resize_start = None,
        }
        cx.notify();
    }

    pub(super) fn focus_composer(
        &mut self,
        _: &FocusComposer,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.composer.update(cx, |c, cx| c.engage(w, cx));
    }

    pub(super) fn text_size_up(
        &mut self,
        _: &super::TextSizeUp,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.text_size(1, cx);
    }

    pub(super) fn text_size_down(
        &mut self,
        _: &super::TextSizeDown,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.text_size(-1, cx);
    }

    pub(super) fn text_size_reset(
        &mut self,
        _: &super::TextSizeReset,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.text_size(0, cx);
    }

    pub(super) fn text_size(&mut self, direction: i8, cx: &mut Context<Self>) {
        let sizes = ["default", "large", "larger"];
        let current = self
            .settings_raw
            .as_deref()
            .and_then(|raw| raw.get("text_size"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("default");
        // `Math.max(0, Math.min(2, index + step))`, with an unknown size at index -1.
        let index = sizes.iter().position(|size| *size == current);
        let next = match direction {
            1 => index.map_or(0, |index| (index + 1).min(2)),
            -1 => index.map_or(0, |index| index.saturating_sub(1)),
            _ => 0,
        };
        let next = sizes[next];
        if next == current {
            return;
        }
        let patch = serde_json::json!({ "text_size": next });
        // An open settings page saves it itself, so the page and the shell stay in step.
        if let Some(view) = &self.settings_view {
            let save = crate::ui::settings::state::Save {
                optimistic: true,
                silent: true,
            };
            view.read(cx).section_ctx().save(patch, save, cx);
            return;
        }
        self.save_text_size(patch, cx);
    }
}
