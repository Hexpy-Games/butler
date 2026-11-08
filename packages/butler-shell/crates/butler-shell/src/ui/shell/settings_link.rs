//! The shell's side of the settings screen (`store.ts` `openSettings`/`closeSettings`) and the
//! app-wide effects of the settings (`AppShell` and `setAppCopyLanguage`): language, the chats
//! intro, developer mode, text size and theme.
use std::rc::Rc;

use butler_ds::ui::context::Ds;
use gpui::{AppContext as _, BorrowAppContext as _, Context, Entity, Window};
use serde_json::Value;

use super::navigation::Navigation;
use super::{Shell, appearance};
use crate::ui::chat::{self, AssistantHooks};
use crate::ui::i18n::Locale;
use crate::ui::settings::sections::normalize;
use crate::ui::settings::{SettingsEvent, SettingsView};

/// `textSizeFactor` (app/textSize.ts).
fn text_scale(value: &str) -> Option<f32> {
    match value {
        "default" => Some(1.),
        "large" => Some(1.15),
        "larger" => Some(1.3),
        _ => None,
    }
}

impl Shell {
    /// `openSettings(section)`: the settings screen replaces the frame; when it is open already
    /// it shows `section` (any route or legacy page name).
    pub(crate) fn open_settings(
        &mut self,
        section: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let section = normalize(section);
        if let Some(view) = &self.settings_view {
            view.update(cx, |view, cx| view.show(section, window, cx));
            return;
        }
        let settings = self.settings_raw.clone();
        let view = cx.new(|cx| SettingsView::new(section, settings, window, cx));
        cx.subscribe_in(&view, window, Self::on_settings).detach();
        self.settings_view = Some(view);
        cx.notify();
    }

    /// `closeSettings`: back to the frame, the composer engaged.
    fn close_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.settings_view = None;
        self.composer.update(cx, |c, cx| c.engage(window, cx));
        cx.notify();
    }

    fn on_settings(
        &mut self,
        _: &Entity<SettingsView>,
        event: &SettingsEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            SettingsEvent::Close => self.close_settings(window, cx),
            SettingsEvent::Changed(raw) => self.apply_settings(raw, cx),
            SettingsEvent::OpenSession(id) => {
                self.close_settings(window, cx);
                self.navigate(Navigation::Session(id.to_string()), window, cx);
            }
            SettingsEvent::Open(_) => {}
        }
    }

    /// What the app does with new settings: the copy follows `language`
    /// (`setAppCopyLanguage`), the transcript reads `chats_intro_seen` and developer mode, and
    /// AppShell applies `text_size` and `appearance_theme` (unless the theme is forced).
    pub(super) fn apply_settings(&mut self, raw: &Rc<Value>, cx: &mut Context<Self>) {
        let flag = |key: &str| raw.get(key).and_then(Value::as_bool);
        let text = |key: &str| raw.get(key).and_then(Value::as_str);
        if let Some(language) = text("language") {
            self.set_locale(Locale::from_language(language), cx);
        }
        if let Some(seen) = flag("chats_intro_seen") {
            chat::set_chats_intro_seen(cx, seen);
        }
        let developer = flag("diagnostics_enabled") == Some(true);
        cx.update_global(|hooks: &mut AssistantHooks, _| hooks.developer_mode = developer);
        if let Some(scale) = text("text_size").and_then(text_scale) {
            Ds::update(cx, |ds| ds.set_ui_scale(scale));
            cx.refresh_windows();
        }
        if !self.forced_theme
            && let Some(theme) = text("appearance_theme")
        {
            self.theme_override = match theme {
                "light" => Some(false),
                "dark" => Some(true),
                _ => None,
            };
            cx.set_window_appearance(self.theme_override.map(appearance));
            if let Some(dark) = self.theme_override {
                self.set_dark(dark, cx);
            }
        }
        self.settings_raw = Some(raw.clone());
        cx.notify();
    }
}
