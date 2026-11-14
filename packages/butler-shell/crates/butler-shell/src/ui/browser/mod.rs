//! Shell-owned browser tabs, address policy and page engine boundary.
pub(crate) mod address;
pub(crate) mod engine;
pub(crate) mod model;
mod placeholder;

pub(crate) fn init(cx: &mut gpui::App) {
    model::BrowserState::init(cx);
}
