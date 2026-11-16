//! The app's settings as every view reads them (`useButlerStore(state => state.settings)`): the
//! last settings the shell applied, kept current by `Shell::apply_settings`.
use std::rc::Rc;

use gpui::{App, Global};
use serde_json::Value;

#[derive(Default)]
pub(crate) struct AppSettings(Option<Rc<Value>>);

impl Global for AppSettings {}

impl AppSettings {
    /// The current settings; `None` until the first load.
    #[expect(
        dead_code,
        reason = "read by the wallpaper surfaces in the next change"
    )]
    pub(crate) fn get(cx: &App) -> Option<Rc<Value>> {
        cx.try_global::<Self>()
            .and_then(|settings| settings.0.clone())
    }

    pub(super) fn set(cx: &mut App, raw: Rc<Value>) {
        cx.set_global(Self(Some(raw)));
    }
}
