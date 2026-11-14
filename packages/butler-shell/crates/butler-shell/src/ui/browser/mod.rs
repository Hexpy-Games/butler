//! Shell-owned browser tabs, address policy and page engine boundary.
pub(crate) mod address;
pub(crate) mod area;
pub(crate) mod engine;
pub(crate) mod model;
mod placeholder;
pub(crate) mod shell_state;
mod tabs;
mod toolbar;

pub(crate) fn init(cx: &mut gpui::App) {
    model::BrowserState::init(cx);
    cx.set_global(shell_state::BrowserShell::default());
}
